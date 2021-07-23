import { readFile } from "fs/promises";
import path = require("path");


export const WORK_DIR = path.resolve(__dirname, "../_work")
export const CONFIG_DIR = process.env["BONK_LOCAL"] == "true" ? path.resolve(__dirname, "../etc.local/") : "/etc/bonkd/"

export interface BonkConfig {
    webhook_url: string,
    github_api_token: string,
    repository: {
        owner: string,
        repo: string,
    }
}

export const DEFAULT_CONFIG: BonkConfig = {
    webhook_url: "",
    github_api_token: "",
    repository: {
        owner: "",
        repo: "",
    }
}

let __config: BonkConfig;
export async function useConfig(): Promise<BonkConfig> {
    return __config || await (async () => {
        __config = JSON.parse(
            await readFile(path.resolve(CONFIG_DIR, "./config.json"), "utf-8")
        )
        return __config
    })()
}