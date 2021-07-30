
import dotenv from "dotenv"
dotenv.config()

import express from "express"
import path from "path"
import { mkdir, readFile, writeFile } from "fs/promises"
import child_process from "child_process"
import util from "util"
import { Db, MongoClient, ObjectId } from "mongodb"
import { downloadRawTextFile, ensureGithubWebhook, useGithub, useWebhookUrl, workflowDispatch } from "./github"
import { useConfig, WORK_DIR } from "./config"
import { useDatabase } from "./utils"
import { LockedResource, requestResources, unlockAll, unlockResourcesForJob } from "./resources"
import cors from "cors"
import { IArtifact, IResource, IWorkGroupRun, IWorkUnit } from "@nyrox/bonk-common/build/tsc/types"

const exec = util.promisify(child_process.exec);

const BONK_TSCONFIG = {

}

const runBonkFile = async (event: any) => {
    const workspace = path.resolve(WORK_DIR, `${event.ref}/${event.after}/`)
    await mkdir(workspace, { recursive: true })
    
    console.info("Created workspace: ", workspace)

    const bonkfile = await downloadRawTextFile(event.after, ".bonk/bonkfile.ts")
    await writeFile(workspace + "/bonkfile.ts", bonkfile)
    await writeFile(workspace + "/tsconfig.json", JSON.stringify(BONK_TSCONFIG, null, 4))
    const packageJson = await downloadRawTextFile(event.after, "package.json")
    const bonkDslVer = JSON.parse(packageJson).dependencies["@nyrox/bonk-dsl"]

    console.log("Using DSL Version: " + bonkDslVer)
    await writeFile(workspace + "/package.json", JSON.stringify({
        dependencies: {
            ["@nyrox/bonk-dsl"]: bonkDslVer,
        }
    }, undefined, 4))
    
    await writeFile(workspace + "/.npmrc", await downloadRawTextFile(event.after, ".npmrc"))
    
    const ref = (event.ref as string).split("/").pop()

    const yarnLogs = await exec("yarn", { cwd: workspace })
    const nodeLogs = await exec("ts-node --project ./tsconfig.json ./bonkfile.ts", { cwd: workspace, env: Object.assign(process.env, {
        BONK_EVENT: "push:" + ref,
        COMMIT_REF: ref,
        COMMIT_HASH: event.after,
    })})
    
    console.log(yarnLogs.stdout, nodeLogs.stderr)
    console.log(nodeLogs.stdout, nodeLogs.stderr)
}



const start = async () => {
    await ensureGithubWebhook()

    const public_serv = express()
        .use(express.json())
        .use(cors({ origin: "*" }))
        .post("/api/run/:id/advance", async (req, res) => {
            console.log("Advancing workflow run: " + req.params.id)
            await poll_all_pending_workflows()
            await advance_workgroup(new ObjectId(req.params.id))

            const db = await useDatabase()
            res.write(JSON.stringify(await db.collection("workgroup_runs").findOne({_id: new ObjectId(req.params.id) })))
            res.end()
        })
        .post("/api/run/:id/cancel", async (req, res) => {
            await cancel_workgroup(new ObjectId(req.params.id))
            const db = await useDatabase()
            res.write(JSON.stringify(await db.collection("workgroup_runs").findOne({_id: new ObjectId(req.params.id) })))
            res.end()
        })
        .post("/api/link-github-run", async (req, res) => {
            const { token, gh_run_id } = req.body

            console.log("Got request to link gh run id " + gh_run_id + " to " + token)

            const db = await useDatabase()
            const hook = await db.collection("gh_workflows").findOneAndUpdate({ 
                _id: new ObjectId(token)
            }, {
                $set: { gh_run_id }
            })

            console.log(hook)

            res.end()
        })
        .post("/api/resources/unlock-all", async (req, res) => {
            console.log("Unlocking all resources")
            await unlockAll()
            res.end()
        })
        .post("*", async (req, res) => {
            const event = req.body
            const db = await useDatabase()
            switch(req.header("X-Github-Event")) {
                case "push":
                    console.info("Received a push event with ref: " + req.body.ref)
                    runBonkFile(event)
                    return;
                case "check_suite":
                    // Little hacky, but this gives a pretty good indication that a workflow finished
                    if (event.check_suite.status == "completed" && event.check_suite.app.slug == "github-actions") {
                        await poll_all_pending_workflows()
                    }
                    break;
                default:
                    break;
            }

            res.end()
        })
        .get("/api/run/list", async (req, res) => {
            const db = await useDatabase()
            res.write(JSON.stringify(await db.collection("workgroup_runs").aggregate(
                [ { $sort: { triggeredAt: -1 }}]
            ).toArray()))
            res.end()
        })
        .get("*", (req, res) => {
            res.status(404)
            res.end()
        })
    
    const privateServ = express()
        .use(express.json())
        .post("/api/workgroup/trigger", async (req, res) => {
            const workflow: IWorkGroupRun = req.body
            console.log(workflow)
            console.log("Got request to start workflow: ", workflow.workgroup_name)

            const workflow_run: IWorkGroupRun = {
                triggeredAt: new Date(),
                ...workflow
            }

            const db = await useDatabase()
            const ret = await db.collection("workgroup_runs").insertOne(workflow_run)

            await advance_workgroup(ret.insertedId)

            res.end()
        })
        .post("/api/run/:run_id/job/:name/finish", async (req, res) => {
            const { name, run_id } = req.params
            console.log(`Marking job ${name} in run ${run_id} as finished.`)

            const db = await useDatabase()
            const run = await db.collection("workgroup_runs").findOne({ _id: new ObjectId(run_id) })

            if (!run) throw new Error("Run " + run_id + " does not exist")

            await finish_job_item(run as IWorkGroupRun, name)

            res.end()
        })
    
    console.info("Starting servers")
    return [public_serv.listen(80), privateServ.listen(9725)]
}

async function poll_all_pending_workflows() {
    console.log("Polling all pending webhooks")

    const db = await useDatabase()
    const workflows = await db.collection("gh_workflows").find(
        { gh_run_id: { $exists: true } }
    )
    
    const config = await useConfig()
    await Promise.all((await workflows.toArray()).map(async (doc) => {
        console.log(doc)

        const github = await useGithub()
        const gh_run = await github.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
            owner: config.repository.owner,
            repo: config.repository.repo,
            run_id: doc.gh_run_id,
        })

        if (gh_run.data.status == "completed") {
            console.log(`${doc.run_id}.${doc.unit} has finished with conclusion: ${gh_run.data.conclusion}`)
            await db.collection("gh_workflows").deleteOne({ _id: doc._id })

            await db.collection("workgroup_runs").findOneAndUpdate({ _id: doc.run_id }, {
                $set: { 
                    [`items.${doc.unit}.finishedAt`]: new Date(),
                    [`items.${doc.unit}.gh_workflow_id`]: doc.gh_run_id,
                    [`items.${doc.unit}.conclusion`]: gh_run.data.conclusion,
                }
            })
        }
    }))
}

async function run_is_finished(run_id: ObjectId): Promise<boolean> {
    const db = await useDatabase()
    const run = await db.collection("workgroup_runs").findOne({ _id: run_id }) as IWorkGroupRun
    for (const item in run.items) {
        if (!run.items[item].finishedAt) return false
    }

    return true
}

async function finish_job_item(run: IWorkGroupRun, item_name: string): Promise<void> {
    const item = run.items[item_name]

    if (!item) throw new Error(`Can't find job "${item_name}" in workgroup run: ${run._id}`)
    if (item.finishedAt) throw new Error(`Job ${item.name} in run ${run._id} already finished!`)

    await unlockResourcesForJob(run._id!, item_name)

    const db = await useDatabase()
    await db.collection("workgroup_runs").updateOne({
        _id: run._id,
    }, {
        $set: { ["items." + item_name + ".finished_at"]: new Date() }
    })

    if (await run_is_finished(run._id!)) {
        await db.collection("workgroup_runs").updateOne({
            _id: run._id,
        }, {
            $set: { finishedAt: new Date() }
        })
    }
}

async function item_request_progress(run: IWorkGroupRun, item: IWorkUnit): Promise<LockedResource[] | null> {
    if (item.triggeredAt) return null;

    const resources: IResource[] = item.inputs.filter(i => i.type == "resource") as IResource[]
    const artifacts: IArtifact[] = item.inputs.filter(i => i.type == "artifact") as IArtifact[]

    const is_next = artifacts
        .map(a => !!run.items[a.producer].finishedAt)
        .reduce((state, v) => state && v, true)
    
    if (!is_next) return null

    const acquiredResources = await requestResources(resources, { run: run._id!, job: item.name })
    if (!acquiredResources) return null

    return acquiredResources
}

async function cancel_workgroup(run_id: ObjectId) {
    const db = await useDatabase()
    const run = (await db.collection("workgroup_runs").findOne({ _id: run_id })) as IWorkGroupRun

    run.lastCheckedAt = new Date()

    let promises = Object.keys(run.items).map(async itemName => {
        const item = run.items[itemName]
    })
}

async function advance_workgroup(run_id: ObjectId) {
    const db = await useDatabase()
    const run = (await db.collection("workgroup_runs").findOne({ _id: run_id })) as IWorkGroupRun

    run.lastCheckedAt = new Date()

    let promises = Object.keys(run.items).map(async itemName => {
        const item = run.items[itemName]
        if (item.triggeredAt) return;

        const resources = await item_request_progress(run, item)

        if (resources == null) {
            console.log(itemName + ": Not able to make progress")
            return;
        }

        console.log(itemName + ": can progress with resources: ", resources)

        const bonk_token = await db.collection("gh_workflows").insertOne({
            run_id: run._id,
            unit: item.name,
        })

        const public_url = await useWebhookUrl()
        
        await workflowDispatch(item.workflow_file, run.commit_ref, {
           __BONK_PUBLIC_URL: public_url,
           __BONK_TOKEN: bonk_token.insertedId.toHexString(),
        })
        run.items[itemName].triggeredAt = new Date()
    });

    await Promise.all(promises)
    await db.collection("workgroup_runs").findOneAndReplace({ _id: run_id }, run)
}


start()