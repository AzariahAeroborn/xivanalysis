import {JobKey} from 'data/JOBS'
import {getActions, getStatuses} from 'data/layer'
import {Event} from 'event'
import {BuffEvent, CastEvent, FflogsEvent} from 'fflogs'
import _ from 'lodash'
import {Actor, Team} from 'report'
import {resolveActorId} from 'reportSources/legacyFflogs/base'
import {AdapterStep} from './base'

const BASE_GCD = 2.5
const CASTER_TAX = 0.1
const JOB_SPEED_MODIFIERS: Partial<Record<JobKey, number>> = {
	'MONK': 0.8,
	'NINJA': 0.85,
}
interface SpeedmodWindow {
	start: number,
	end?: number,
}

class GCD {
	prepare: CastEvent | undefined
	action: CastEvent | undefined

	get isInterrupted(): boolean { return this.prepare != null && this.action == null }
	get isInstant(): boolean { return this.action != null && this.prepare == null }

	get start(): number {
		if (this.prepare != null) { return this.prepare.timestamp }
		if (this.action != null) { return this.action.timestamp } // Instant cast action - no prepare event
		throw new Error('Unexpected GCD with no prepare or action event')
	}

	get actionId(): number {
		if (this.prepare != null) { return this.prepare.ability.guid }
		if (this.action != null) { return this.action.ability.guid }
		throw new Error('Unexpected GCD with no prepare or action event')
	}
}

export class SpeedStatsAdapterStep extends AdapterStep {
	private actorActions = new Map<Actor['id'], GCD[]>()
	private actorSpeedmodWindows = new Map<Actor['id'], Map<number, SpeedmodWindow[]>>()

	static debug = true
	private endTimestamp = 0

	adapt(baseEvent: FflogsEvent, adaptedEvents: Event[]) {
		switch (baseEvent.type) {
		case 'begincast':
		case 'cast':
			this.trackAction(baseEvent)
			break
		case 'applybuff':
			this.startSpeedmodWindow(baseEvent)
			break
		case 'removebuff':
			this.endSpeedmodWindow(baseEvent)
			break
		case 'encounterend':
			this.endTimestamp = baseEvent.timestamp
			break
		}

		return adaptedEvents
	}

	postprocess(adaptedEvents: Event[]): Event[] {
		this.actorActions.forEach(this.estimateActorSpeedStat, this)

		return adaptedEvents
	}

	private trackAction(event: CastEvent) {
		const actorId = resolveActorId({id: event.sourceID})
		if (this.actorIsNotFriendly(actorId)) { return }

		const action = _.find(getActions(this.report), a => a.id === event.ability.guid)
		if (!action?.onGcd) {
			return
		}

		let gcds = this.actorActions.get(actorId)
		if (gcds == null) {
			gcds = new Array<GCD>()
			this.actorActions.set(actorId, gcds)
		}

		if (event.type === 'cast') {
			if (gcds.length > 0) {
				const lastInterval = gcds[gcds.length - 1]
				if (lastInterval.action == null && lastInterval.prepare != null && lastInterval.prepare.ability.guid === event.ability.guid) {
					lastInterval.action = event
					return
				}
			}

			const gcd = new GCD()
			gcd.action = event
			gcds.push(gcd)
		} else {
			const gcd = new GCD()
			gcd.prepare = event
			gcds.push(gcd)
		}
	}

	private startSpeedmodWindow(event: BuffEvent) {
		const actorId = resolveActorId({id: event.sourceID})
		if (this.actorIsNotFriendly(actorId)) { return }

		const status = _.find(getStatuses(this.report), s => s.id === event.ability.guid)
		if (status?.speedModifier == null) {
			return
		}

		let windows = this.actorSpeedmodWindows.get(actorId)
		if (windows == null) {
			windows = new Map<number, SpeedmodWindow[]>()
			this.actorSpeedmodWindows.set(actorId, windows)
		}
		let windowMap = windows.get(status.id)
		if (windowMap == null) {
			windowMap = new Array<SpeedmodWindow>()
			windows.set(status.id, windowMap)
		}
		windowMap.push({start: event.timestamp})
	}

	private endSpeedmodWindow(event: BuffEvent) {
		const actorId = resolveActorId({id: event.sourceID})
		if (this.actorIsNotFriendly(actorId)) { return }

		const status = _.find(getStatuses(this.report), s => s.id === event.ability.guid)
		if (status?.speedModifier == null) {
			return
		}

		const windows = this.actorSpeedmodWindows.get(actorId)
		if (windows == null) {
			throw new Error('Received statusRemove event for an actor with no open speedmod windows')
		}
		const windowMap = windows.get(status.id)
		if (windowMap == null || windowMap[windowMap.length-1].end != null) {
			throw new Error('Received statusRemove event for a status with no open speedmod windows')
		}
		windowMap[windowMap.length-1].end = event.timestamp
	}

	private actorIsNotFriendly(actorId: string): boolean {
		const actor = this.pull.actors.find(a => a.id === actorId)
		return actor?.team !== Team.FRIEND
	}

	private estimateActorSpeedStat(gcds: GCD[], actorId: string) {
		const intervalGroups = new Map<number, number>()

		gcds.forEach((gcd, idx) => {
			const previous = gcds[idx - 1]
			if (previous == null || previous.isInterrupted) { return }

			const rawIntervalSeconds = (gcd.start - previous.start) / 1000
			let isCasterTaxed = false
			let castTimeScale = 1

			if (!previous.isInstant) {
				const action = _.find(getActions(this.report), a => a.id === previous.actionId)
				if (action != null && action.castTime != null && action.castTime >= BASE_GCD) {
					isCasterTaxed = true
					castTimeScale = action.castTime / BASE_GCD
				}
			}

			const speedModifier = this.getSpeedModifierAtTimestamp(previous.start, actorId)

			const intervalSeconds = _.ceil((rawIntervalSeconds - (isCasterTaxed ? CASTER_TAX : 0)) / castTimeScale / speedModifier, 2)

			// The below debug is useful if you need to trace individual interval calculations, but will make your console really laggy if you enable it without any filter
			//this.debug(`Actor ID: ${actorId} - Event at ${previous.start} - Raw Interval: ${rawIntervalSeconds}s - Caster Tax: ${isCasterTaxed} - Cast Time Scale: ${castTimeScale} - Speed Modifier: ${speedModifier} - Calculated Interval: ${intervalSeconds}s`)

			const count = intervalGroups.get(intervalSeconds) ?? 0
			intervalGroups.set(intervalSeconds, count + 1)
		})

		this.debug(`Actor ID: ${actorId} - Event Intervals ${JSON.stringify(Array.from(intervalGroups.entries()).sort((a, b) => b[1] - a[1]))}`)
	}

	private getSpeedModifierAtTimestamp(timestamp: number, actorId: string) {
		const actorWindows = this.actorSpeedmodWindows.get(actorId)
		let speedModifier = 1

		const actor = this.pull.actors.find(a => a.id === actorId)
		if (actor != null) {
			speedModifier *= JOB_SPEED_MODIFIERS[actor.job] ?? 1
		}

		if (actorWindows == null) {
			return speedModifier
		}

		actorWindows.forEach((windows, statusId) => {
			if (windows.some(w => w.start < timestamp && timestamp <= (w.end ?? this.endTimestamp))) {
				const status = _.find(getStatuses(this.report), s => s.id === statusId)
				if (status != null && status.speedModifier != null) {
					speedModifier *= status.speedModifier
				}
			}
		})

		return speedModifier
	}
}
