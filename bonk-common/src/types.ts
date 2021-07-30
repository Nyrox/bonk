import { ObjectId } from "mongodb";


export enum UnitStatus {
    Queued = "Queued",
    Scheduled = "Scheduled",
    Running = "Running",
    Finished = "Finished",
    Cancelled = "Cancelled",
    Failed = "Failed",
}

export enum WorkflowStatus {
    Finished = "Finished",
    Failed = "Failed",
    Cancelled = "Cancelled",
    Running = "Running",
}


interface IInput {
    type: InputType
}

export interface IArtifact extends IInput {
    type: "artifact",
    producer: string,
    name: string,
}

export interface IResource extends IInput {
    type: "resource",
    resource_set: string,
    filters: Record<string, string>,
}


export type InputType = "artifact" | "resource"
export type Input = IArtifact | IResource


export interface IWorkUnit {
    _id?: ObjectId,
    triggeredAt?: Date,
    finishedAt?: Date,
    ghWorkflowId?: string,

    name: string,
    workflow_file: string,
    inputs: Input[],
    status: UnitStatus,
}

export interface IWorkGroupRun {
    _id?: ObjectId,
    triggeredAt?: Date,
    finishedAt?: Date,
    lastCheckedAt?: Date,
    lastProgressAt?: Date,

    workgroup_name: string,
    items: Record<string, IWorkUnit>,
    commit_ref: string,
    commit_hash: string,
    status: WorkflowStatus,
}