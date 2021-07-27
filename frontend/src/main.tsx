import classNames from 'classnames'
import React, { ReactElement, useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { Provider } from 'react-redux'
import { ExtendedWorkUnit, dsl } from "@nyrox/bonkd"
import { Table } from './components/bulma'
import { Expandable } from './components/expandable'

import './index.scss'
import * as Store from "./store"
import { useAppDispatch, useAppSelector } from './store'

enum ItemState {
	Finished,
	Failed,
	Aborted,
	InProgress,
	Scheduled,
}

function formatDate(input: Date | string) {
	let date = typeof input == "string" ? new Date(input) : input

	return date.toLocaleString("EN", { 
		month: "2-digit", day: "2-digit", year: "2-digit",
		hour: "2-digit", minute: "2-digit" })
}

const ItemInput = ({ input }: {input: dsl.Input}) => {
	switch (input.type) {
		case "artifact":
			return <li>Artifact <span className="is-family-monospace has-background-light">{input.name}</span> from job: <span className="is-family-monospace has-background-light">{input.producer}</span></li>
		case "resource":
			return <li>Resource from set: <span className="is-family-monospace has-background-light">{input.resource_set}</span></li>
	}
}

const BuildItem = ({ item }: { item: ExtendedWorkUnit }) => {
	const itemState: ItemState = item.triggeredAt ?
		(item.finishedAt ? ItemState.Finished : ItemState.InProgress) : ItemState.Scheduled

	return <li className="build-item">
		<div className="level mb-0">
			<div className="level-left">
				<h4 className="mr-6"><span className="has-text-weight-bold">{item.name}</span><span style={{ width: "8px", display: "inline-block" }} />[{item.workflow_file}]</h4>
			</div>
			<div className="level-right">
				{
					Object.values(ItemState)[itemState]
				}
			</div>
		</div>

		<div>
			<h4 className="has-text-weight-bold">Inputs: {item.inputs.length == 0 ? "None" : ""}</h4>
			<div>
				{ item.inputs.map((i, n) => <ItemInput key={n} input={i} />)}
			</div>
		</div>
	</li>
}

export interface WorkgroupRunDetailsProps {
	id: string
}

const WorkgroupRunDetails = ({ id }: WorkgroupRunDetailsProps) => {
	const run = useAppSelector(state => state.workgroupRuns.runs.find(r => r._id as any == id))
	const dispatch = useAppDispatch()

	if (!run) throw new Error("bruh")

	const [isWaiting, setIsWaiting] = useState(false)

	const advanceManually = async () => {
		setIsWaiting(true)
		const res = await fetch("http://localhost/api/run/" + id + "/advance", { method: "POST" })
		dispatch(Store.updateRun(await res.json()))
		setIsWaiting(false)
	}

	return <div className="card p-2">
		<div className="p-2">
			<h4>Last Updated: { formatDate(run.lastCheckedAt || "") }</h4>
			<button onClick={advanceManually} className={classNames("button", { "is-loading": isWaiting })}>Update manually</button>
		</div>
		<h3 className="has-text-weight-bold px-2 is-size-5 is-underlined">Jobs</h3>
		<ul className="build-items">
			{Object.keys(run.items).map(k => <BuildItem key={k} item={run.items[k]} />)}
		</ul>
	</div>
}

const BruhComponent = () => {
	const { runs } = useAppSelector(state => state.workgroupRuns)
	const dispatch = useAppDispatch()

	useEffect(() => {
		const fetchRuns = async () => {
			const runs = await fetch("http://localhost/api/run/list")
			dispatch(Store.runsLoaded(await runs.json()))
		}

		fetchRuns()
	}, [])

	const columns = ["Workgroup", "Triggered At", "Ref", "Commit", "Status"]

	return <div>
		<h2 className="subtitle">Latest Workgroup Runs</h2>
		<Table columns={columns} hover className="box is-inline-block">
			{runs.map(r => <Expandable key={r._id as any} render={(isExpanded, onClick) => (<>
				<tr onClick={onClick} className={classNames("is-clickable", { "is-selected": isExpanded })}>
					<td>{r.name}</td>
					<td>{ formatDate(r.triggeredAt!) }</td>
					<td>{r.commit_ref}</td>
					<td>{r.commit_hash.substr(0, 7)}</td>
					<td>{r.finishedAt || "In Progress"}</td>
				</tr>
				{isExpanded ?
					<tr className="extended-panel">
						<td className="p-0" colSpan={columns.length}>
							<WorkgroupRunDetails id={r._id as any} />
						</td>
					</tr> : null}
			</>)} />)}
		</Table>
	</div>
}


ReactDOM.render(
	<React.StrictMode>
		<Provider store={Store.store}>
			<section className="section">
				<BruhComponent />
			</section>
		</Provider>
	</React.StrictMode>,
	document.getElementById('root')
)
