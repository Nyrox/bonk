import classNames from 'classnames'
import React, { ReactElement, useEffect, useState } from 'react'
import ReactDOM from 'react-dom'
import { Provider } from 'react-redux'
import { Input, IWorkUnit, UnitStatus } from "@nyrox/bonk-common"
import { Table } from './components/bulma'
import { Expandable } from './components/expandable'

import './index.scss'
import * as Store from "./store"
import { useAppDispatch, useAppSelector } from './store'

function formatDate(input: Date | string) {
	let date = typeof input == "string" ? new Date(input) : input

	return date.toLocaleString("EN", { 
		month: "2-digit", day: "2-digit", year: "2-digit",
		hour: "2-digit", minute: "2-digit" })
}

const ItemInput = ({ input }: {input: Input}) => {
	switch (input.type) {
		case "artifact":
			return <li>Artifact <span className="is-family-monospace has-background-light">{input.name}</span> from job: <span className="is-family-monospace has-background-light">{input.producer}</span></li>
			break;
		case "resource":
			return <li>Resource from set: <span className="is-family-monospace has-background-light">{input.resource_set}</span></li>
			break;
	}
}

function elapsed_time_since(input: Date | string): string {
	let date = typeof input == "string" ? new Date(input) : input
	let diff = ((new Date()).getTime() - date.getTime()) / 1000

	const formatNum = (num: number) => Math.floor(num).toLocaleString(undefined, { minimumIntegerDigits: 2})

	return  formatNum(diff / 60 / 60) + ":" + 
			formatNum(diff / 60 % 60) + ":" + 
			formatNum(diff % 60)
}

const BuildItem = ({ item }: { item: IWorkUnit }) => {
	const [_hack, setHack] = useState(0)
	useEffect(() => {
		const h = setTimeout(() => setHack(_hack + 1), 1000)
		return () => clearTimeout(h)
	})
	
	const statusText: Record<UnitStatus, () => ReactElement> = {
		[UnitStatus.Queued]: () => <>Queued</>,
		[UnitStatus.Running]: () => <>Running for&nbsp;<span className="is-family-monospace">{elapsed_time_since(item.triggeredAt!)}</span></>,
		[UnitStatus.Scheduled]: () => <>Scheduled</>,
		[UnitStatus.Finished]: () => <span className="has-text-success">Finished</span>,
		[UnitStatus.Failed]: () => <span className="has-text-danger">Failed</span>,
		[UnitStatus.Cancelled]: () => <>Cancelled</>,
	}
	
	return <div className="build-item">
			
		<div className="level mb-0">
			<div className="level-left">
				<h4 className="mr-6"><span className="has-text-weight-bold">{item.name}</span><span style={{ width: "8px", display: "inline-block" }} />[{item.workflow_file}]</h4>
			</div>
			<div className="level-right">
				{
					statusText[item.status]()
				}
			</div>
		</div>

		<div>
			<h4 className="has-text-weight-bold">Inputs: {item.inputs.length == 0 ? "None" : ""}</h4>
			<ul>
				{ item.inputs.map((i, n) => <ItemInput key={n} input={i} />)}
			</ul>
		</div>
	</div>
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
		if (isWaiting) return;

		setIsWaiting(true)
		const res = await fetch("http://localhost/api/run/" + id + "/advance", { method: "POST" })
		dispatch(Store.updateRun(await res.json()))
		setIsWaiting(false)
	}

	const cancelRun = async () => {
		if (isWaiting) return;

		setIsWaiting(true)
		const res = await fetch("http://localhost/api/run/" + id + "/cancel", { method: "POST" })
		dispatch(Store.updateRun(await res.json()))
		setIsWaiting(false)
	}

	return <div className="card p-2">
		<div className="p-2">
			<h4 className="">Last Updated: { formatDate(run.lastCheckedAt || "") }</h4>
			<h4 className="mb-2">Last Progressed: { formatDate(run.lastProgressAt || "") }</h4>
			<button onClick={advanceManually} className={classNames("button", { "is-loading": isWaiting })}>Update manually</button>
			<button onClick={cancelRun} className={classNames("button is-danger ml-4", { "is-loading": isWaiting })}>Cancel</button>
		</div>
		<h3 className="has-text-weight-bold px-2 is-size-5 is-underlined">Jobs</h3>
		<ul className="build-items">
			{Object.keys(run.items).map(k => <li key={k}><BuildItem item={run.items[k]} /></li>)}
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

	const columns = [
		"Workgroup",
		"Ref",
		"Commit",
		"Triggered At",
		"Status"
	]

	return <div>
		<h2 className="subtitle">Latest Workgroup Runs</h2>
		<Table columns={columns} hover className="box is-inline-block">
			{runs.map(r => <Expandable key={r._id as any} render={(isExpanded, onClick) => (<>
				<tr onClick={onClick} className={classNames("is-clickable", { "is-selected": isExpanded })}>
					<td>{r.workgroup_name}</td>
					<td>{r.commit_ref}</td>
					<td>{r.commit_hash.substr(0, 7)}</td>
					<td>{ formatDate(r.triggeredAt!) }</td>
					<td>{r.status}</td>
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

function dirt() {
	fetch("http://localhost/api/resources/unlock-all", { method: "POST" })
}

ReactDOM.render(
	<React.StrictMode>
		<Provider store={Store.store}>
			<section className="section">
			<button className="button is-danger" onClick={dirt}>Unlock all resources</button>

			</section>
			<section className="section">
				<BruhComponent />
			</section>
		</Provider>
	</React.StrictMode>,
	document.getElementById('root')
)
