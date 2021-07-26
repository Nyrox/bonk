import React, { useEffect } from 'react'
import ReactDOM from 'react-dom'
import { Provider } from 'react-redux'

import './index.css'
import * as Store from "./store"
import { useAppSelector } from './store'


const BruhComponent = () => {
	const { runs } = useAppSelector(state => state.workgroupRuns)
	const dispatch = Store.useAppDispatch()

	useEffect(() => {
		const fetchRuns = async () => {
			const runs = await fetch("http://localhost/api/run/list")
			dispatch(Store.runsLoaded(await runs.json()))
		}

		fetchRuns()
	}, [])

	return <div>
		<h2>Workgroup Runs</h2>
		<ul>
			{ runs.map(r => <li>{ r.name }</li>) }
		</ul>
	</div>
}


ReactDOM.render(
	<React.StrictMode>
		<Provider store={Store.store}>
			<BruhComponent />
		</Provider>
	</React.StrictMode>,
	document.getElementById('root')
)
