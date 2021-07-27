import { configureStore, createSlice } from "@reduxjs/toolkit"
import { TypedUseSelectorHook, useDispatch, useSelector } from "react-redux"

import { WorkGroupRun } from "@nyrox/bonkd"

interface WorkgroupStore {
    runs: WorkGroupRun[]
}

const initialState: WorkgroupStore = { runs: [] }

const workgroupSlice = createSlice({
    name: "workgroupRuns",
    initialState,
    reducers: {
        runsLoaded(state, action: { type: string, payload: WorkGroupRun[] }) {
            state.runs = action.payload
        },
        updateRun(state, action: { type: string, payload: WorkGroupRun }) {
            const index = state.runs.findIndex(r => r._id == action.payload._id)
            if (index !== -1) {
                state.runs[index] = action.payload
            } else {
                state.runs.push(action.payload)
            }
        }
    }
})

export const { runsLoaded, updateRun } = workgroupSlice.actions

export const store = configureStore({
    reducer: {
        workgroupRuns: workgroupSlice.reducer,
    }
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

export const useAppDispatch = () => useDispatch<AppDispatch>()
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector