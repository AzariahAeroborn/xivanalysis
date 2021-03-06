import {Trans} from '@lingui/react'
import {ActionLink, StatusLink} from 'components/ui/DbLink'
import {getDataBy} from 'data'
import {Status} from 'data/STATUSES'
import {BuffEvent, CastEvent} from 'fflogs'
import Module, {dependency} from 'parser/core/Module'
import {Data} from 'parser/core/modules/Data'
import Suggestions, {SEVERITY, TieredSuggestion} from 'parser/core/modules/Suggestions'
import React from 'react'
import Sect from './Sect'

const SEVERITY_MOD = {
	MINOR: 0.1,
	MEDIUM: 0.3,
	MAJOR: 0.5,
}

// Lifted from WHM benison and adapted to AST and TSX
export default class CelestialOpposition extends Module {
	static override handle = 'celestialopposition'

	@dependency private data!: Data
	@dependency private suggestions!: Suggestions
	@dependency private sect!: Sect

	private lastUse = 0
	private uses = 0
	private totalHeld = 0

	private activeSect: Status | undefined

	protected override init() {
		this.addEventHook('cast', {abilityId: this.data.actions.CELESTIAL_OPPOSITION.id, by: 'player'}, this.onCast)
		this.addEventHook('applybuff', {abilityId: [this.data.statuses.DIURNAL_SECT.id, this.data.statuses.NOCTURNAL_SECT.id], by: 'player'}, this.onSect)
		this.addEventHook('complete', this.onComplete)
	}

	private onCast(event: CastEvent) {
		this.uses++
		if (this.lastUse === 0) { this.lastUse = this.parser.fight.start_time }

		const held = event.timestamp - this.lastUse - this.data.actions.CELESTIAL_OPPOSITION.cooldown
		if (held > 0) {
			this.totalHeld += held
		}
		// update the last use
		this.lastUse = event.timestamp
	}

	private onSect(event: BuffEvent) {
		this.activeSect = getDataBy(this.data.statuses, 'id', event.ability.guid)
	}

	onComplete() {
		const holdDuration = this.uses === 0 ? this.parser.currentDuration : this.totalHeld
		const usesMissed = Math.floor(holdDuration / this.data.actions.CELESTIAL_OPPOSITION.cooldown)
		const fightDuration = this.parser.fight.end_time - this.parser.fight.start_time
		const maxUses = (fightDuration / this.data.actions.CELESTIAL_OPPOSITION.cooldown) - 1

		const WASTED_USE_TIERS = {
			[maxUses * SEVERITY_MOD.MINOR]: SEVERITY.MINOR,
			[maxUses * SEVERITY_MOD.MEDIUM]: SEVERITY.MEDIUM,
			[maxUses * SEVERITY_MOD.MAJOR]: SEVERITY.MAJOR, // if not used at all, it'll be set to 100 for severity checking
		}
		const suggestContentDiurnal = <Trans id="ast.celestial-opposition.suggestion.content.diurnal">
				Use <ActionLink {...this.data.actions.CELESTIAL_OPPOSITION} /> more frequently. In <StatusLink {...this.data.statuses.DIURNAL_SECT} />, the heal and regen combined add up to the same potency of a <ActionLink {...this.data.actions.BENEFIC_II} /> on each player it reaches.
				Trusting the regens to top off the party HP will save MP and GCDs on healing.
		</Trans>
		const suggestContentNoct = <Trans id="ast.celestial-opposition.suggestion.content.noct">
				Use <ActionLink {...this.data.actions.CELESTIAL_OPPOSITION} /> more frequently. In <StatusLink {...this.data.statuses.NOCTURNAL_SECT} />, the shield is the same potency as from <ActionLink {...this.data.actions.ASPECTED_HELIOS} />,
				so it can save MP and GCDs casting it. Since shields last 30 seconds it can be cast much earlier than incoming damage and allow the cooldown to refresh sooner.
		</Trans>

		const content = this.activeSect && this.activeSect.id === this.data.statuses.NOCTURNAL_SECT.id ? suggestContentNoct : suggestContentDiurnal

		if (usesMissed > 1 || this.uses === 0) {
			this.suggestions.add(new TieredSuggestion({
				icon: this.data.actions.CELESTIAL_OPPOSITION.icon,
				content,
				tiers: WASTED_USE_TIERS,
				value: this.uses === 0 ? 100 : usesMissed,
				why: <Trans id="ast.celestial-opposition.suggestion.why">
					About {usesMissed} uses of <ActionLink {...this.data.actions.CELESTIAL_OPPOSITION} /> were missed by holding it for at least a total of {this.parser.formatDuration(holdDuration)}.
				</Trans>,
			}))
		}
	}
}
