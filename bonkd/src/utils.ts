import { MongoClient, Db } from "mongodb";



let __mongo_handle: MongoClient;
let __database_handle: Db;
export const useDatabase = async () => {
    return __database_handle || await (async () => {
        __mongo_handle = new MongoClient("mongodb://localhost:27017")
        await __mongo_handle.connect()
        __database_handle = __mongo_handle.db("bonkd")
        return __database_handle
    })()
}