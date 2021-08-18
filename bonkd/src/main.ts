
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
import { IArtifact, IResource, IWorkGroupRun, IWorkUnit, UnitStatus } from "@nyrox/bonk-common/build/tsc/types"
import { Result, Ok, Err } from "ts-results"


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
    const bonkDslVer = JSON.parse(packageJson).devDependencies["@nyrox/bonk-dsl"] || JSON.parse(packageJson).dependencies["@nyrox/bonk-dsl"]

    console.log("Using DSL Version: " + bonkDslVer)
    await writeFile(workspace + "/package.json", JSON.stringify({
        dependencies: {
            ["@nyrox/bonk-dsl"]: bonkDslVer,
        }
    }, undefined, 4))
    
    await writeFile(workspace + "/.npmrc", await downloadRawTextFile(event.after, ".npmrc"))
    
    const ref = (event.ref as string).split("/").slice(2).join("/")
    console.log(ref)
    const yarnLogs = await exec("yarn", { cwd: workspace })
    const nodeLogs = await exec("ts-node --project ./tsconfig.json ./bonkfile.ts", { cwd: workspace, env: Object.assign(process.env, {
        BONK_EVENT: "push:" + ref,
        COMMIT_REF: ref,
        COMMIT_HASH: event.after,
    })})
    
    console.log(yarnLogs.stdout, yarnLogs.stderr)
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

            let workgroup_run = await db.collection("workgroup_runs").findOneAndUpdate({ _id: hook.value!.run_id }, {
                $set: { 
                    [`items.${hook.value!.unit}.status`]: UnitStatus.Running,
                    [`items.${hook.value!.unit}.gh_run_id`]: gh_run_id,
                }
            })

            console.log(hook)

            res.json({
                unit: hook.value!.unit,
                workgroup_run: workgroup_run.value,
            })
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
                    if ((event.head_commit.message as string).includes("[bonk_dummy_commit]")) {
                        console.info("Skipping dummy commit")
                        return;
                    }
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
            res.end("404")
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

            const status = {
                "success": UnitStatus.Finished,
                "failure": UnitStatus.Failed,
            }[gh_run.data.conclusion as string] || (() => { throw new Error("Unknown conclusion:" + gh_run.data.conclusion) })()

            const workgroup_run = await db.collection("workgroup_runs").findOne({ _id: doc.run_id })
            await finish_job_item(workgroup_run as IWorkGroupRun, doc.unit, status)
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

async function finish_job_item(run: IWorkGroupRun, item_name: string, status: UnitStatus): Promise<void> {
    const item = run.items[item_name]

    if (!item) throw new Error(`Can't find job "${item_name}" in workgroup run: ${run._id}`)
    if (item.finishedAt) throw new Error(`Job ${item.name} in run ${run._id} already finished!`)

    await unlockResourcesForJob(run._id!, item_name)

    const db = await useDatabase()
    await db.collection("workgroup_runs").updateOne({
        _id: run._id,
    }, {
        $set: {
            ["items." + item_name + ".finishedAt"]: new Date(),
            ["items." + item_name + ".status"]: status,
        }
    })

    if (await run_is_finished(run._id!)) {
        await db.collection("workgroup_runs").updateOne({
            _id: run._id,
        }, {
            $set: { finishedAt: new Date() }
        })
    } else {
        await advance_workgroup(run._id!)
    }
}

interface MissingPrerequisiteBuilds {
    reason: "MissingPrerequisiteBuilds",
    missing: string[],
}

interface MissingResources {
    reason: "MissingResources",
    resources: IResource[],
}

interface AlreadyTriggered {
    reason: "AlreadyTriggered",
}

type NoProgressReason = MissingPrerequisiteBuilds | MissingResources | AlreadyTriggered

async function item_request_progress(run: IWorkGroupRun, item: IWorkUnit): Promise<Result<LockedResource[], NoProgressReason>> {
    if (item.triggeredAt) return Err({ reason: "AlreadyTriggered" })

    const resources: IResource[] = item.inputs.filter(i => i.type == "resource") as IResource[]
    const artifacts: IArtifact[] = item.inputs.filter(i => i.type == "artifact") as IArtifact[]

    const prerequisites = artifacts
        .map(a => run.items[a.producer])
        .filter(run => !run.finishedAt)
    
    if (prerequisites.length > 0) return Err({ reason: "MissingPrerequisiteBuilds", missing: prerequisites.map(a => a.name) })

    return (await requestResources(resources, { run: run._id!, job: item.name }))
            .mapErr(resources => ({ reason: "MissingResources", resources }))
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
        if (resources.err) {
            console.log(itemName + ": can't progress because: ", JSON.stringify(resources.val, undefined, 4))
            return;
        }

        console.log(itemName + ": can progress with resources: ", resources.val)

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
        run.items[itemName].status = UnitStatus.Scheduled
    });

    await Promise.all(promises)
    await db.collection("workgroup_runs").findOneAndReplace({ _id: run_id }, run)
}


start()