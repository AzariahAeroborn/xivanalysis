import _ from 'lodash'
import React, {Component} from 'react'
import {disposeOnUnmount, observer} from 'mobx-react'
import {observable, reaction, runInAction} from 'mobx'
import {getFflogsEvents} from '../api'
import {Actor, CastEvent} from '../fflogs'
import {PossiblyLoadedReport, Report} from 'store/report'
import {Event} from '../events'
import {StoreContext} from '../store'
import {getDataBy} from 'data'
import {Action, layers as actionLayers, root as actionRoot} from 'data/ACTIONS'
import {applyLayer, Layer} from 'data/layer'
import {GameEdition} from '../data/PATCHES'
import {Patch} from 'parser/core/Patch'

const FFLOGS_ACTORID_OFFSET = 999999

interface FetchEventParams {
	report: PossiblyLoadedReport | undefined,
	params: any,
}

interface ActorEvents {
	actor: Actor,
	events: Event[],
	histogram: any,
}

interface GCDAction {
	action: Action,
	start?: number,
	cast?: number,
}

interface GCDHistogram {
	interval: number,
	count: number,
}

class Data {
	private appliedCache = new Map<unknown, unknown>()
	private patch: Patch

	constructor(reportTimestamp: number) {
		this.patch = new Patch (
			GameEdition.GLOBAL,
			reportTimestamp,
		)
	}

	get actions() {
		return this.getAppliedData(actionRoot, actionLayers)
	}

	getAction(id: Action['id']) {
		return getDataBy(this.actions, 'id', id)
	}

	private getAppliedData<R>(root: R, layers: Array<Layer<R>>): R {
		const cached = this.appliedCache.get(root)
		if (cached) {
			return cached as R
		}

		const applied = layers
			.filter(layer => this.patch.compare(layer.patch) >= 0)
			.reduce(applyLayer, root)
		this.appliedCache.set(root, applied)

		return applied
	}
}

@observer
export default class GCDSummary extends Component<any, any> {
	static contextType = StoreContext

	@observable eventStore: ActorEvents[] = []
	@observable complete = false

	private data: Data | undefined

	get fightId() {
		return parseInt(this.props.match.params.fight, 10)
	}

	componentDidMount() {
		const {reportStore} = this.context
		const {match} = this.props
		reportStore.fetchReportIfNeeded(match.params.code)

		disposeOnUnmount(this, reaction(
			() => ({
				report: reportStore.report,
				params: match.params,
			}),
			this.fetchEventsAndParseIfNeeded,
			{fireImmediately: true},
		))
	}

	fetchEventsAndParseIfNeeded = async ({report, params}: FetchEventParams) => {
		const eventStore: ActorEvents[] = []

		if (report && !report.loading && report.code === params.code && params.fight) {
			const fight = report.fights.find((fight: { id: number; }) => fight.id === this.fightId)
			const combatants = report.friendlies

			if (fight) {
				this.data = new Data(report.start)

				for (const combatant of combatants) {
					if (combatant.fights.find(f => f.id === fight.id )) {
						// combatant took part in fight, retrieve events
						const events = await getFflogsEvents(
							report.code,
							fight,
							{filter: `type IN ('cast', 'begincast') AND source.id = ${combatant.id + FFLOGS_ACTORID_OFFSET}`},
						)
						const gcdEvents = events.filter(evt =>
							( evt.type === 'cast' || evt.type === 'begincast' )
							&& this.data
							&& this.data.getAction(evt.ability.guid)?.onGcd)
						eventStore.push({actor: combatant, events, histogram: this.buildGCDHistogram(gcdEvents)})
					}
				}
			}
		}

		runInAction(() => {
			this.eventStore = eventStore
			this.complete = true
		})
	}

	render() {
		if (!this.complete) {
			return (
				<div>Loading...</div>
			)
		}

		return (
			<>
			{this.eventStore.filter(e => e.histogram.length > 0).map(actorEvents => {
				return (
					<div style={{marginBottom: '3em'}}>
						<div style={{fontWeight: 700}}>{actorEvents.actor.name}</div>
						<table>
							<thead>
							<tr>
								<th>GCD Interval</th>
								<th>Count</th>
							</tr>
							</thead>
							<tbody>
							{
								actorEvents.histogram.map((i: GCDHistogram) => {
									return (
										<tr>
											<td>{i.interval}</td>
											<td>{i.count}</td>
										</tr>
									)
								})
							}
							</tbody>
						</table>
					</div>
				)
			})}
			</>
		)
	}

	buildGCDHistogram = (events: Event[]): GCDHistogram[] => {
		if (events.length === 0) { return [] }

		const gcdActions = this.buildGCDActions(events)
		const gcdIntervals = gcdActions.map((action, idx) => {
			if (idx > 1) {
				const actionStart = action.start ?? action.cast
				const lastActionStart = gcdActions[idx-1].start ?? gcdActions[idx-1].cast
				if (actionStart && lastActionStart) {
					return actionStart - lastActionStart
				}
			}
		}).filter(interval => interval != null)

		// @ts-ignore
		// tslint:disable-next-line:no-magic-numbers
		const histogram = _.countBy(gcdIntervals, interval => Math.round(interval / 10) * 10)
		const gcdHistogram: GCDHistogram[] = []
		for (const [key, value] of Object.entries(histogram)) {
			gcdHistogram.push({interval: parseInt(key, 10), count: value})
		}
		return gcdHistogram
	}

	buildGCDActions = (events: Event[]) : GCDAction[] => {
		if (!this.data) { return [] }

		const gcds: GCDAction[] = []

		for (let i = 0; i < events.length; i++) {
			const event = events[i]
			const action = (event.ability) ? this.data.getAction(event.ability.guid) : undefined

			// Couldn't locate an action for this event ID - skip
			if (!action) { continue }

			// If initial event is a 'cast' event of an action that has a cast time, ignore it (pre-pull cast)
			if (i === 0 && event.type === 'cast' && (action?.castTime ?? 0 > 0)) { continue }

			if (event.type === 'begincast') {
				gcds.push({start: event.timestamp, action})
			} else if (event.type === 'cast') {
				// Check if this was completing a begincast event
				const lastAction = _.last(gcds)
				if (lastAction && !lastAction.cast && lastAction.action.id === action.id) {
					lastAction.cast = event.timestamp
				} else {
					// Otherwise this is an instant cast
					gcds.push({cast: event.timestamp, action})
				}
			}
		}

		return gcds
	}
}
