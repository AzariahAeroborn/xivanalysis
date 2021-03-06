import {Plural, Trans} from '@lingui/react'
import {ActionLink, StatusLink} from 'components/ui/DbLink'
import ACTIONS from 'data/ACTIONS'
import STATUSES from 'data/STATUSES'
import {BuffEvent, CastEvent} from 'fflogs'
import Module, {dependency} from 'parser/core/Module'
import Combatants from 'parser/core/modules/Combatants'
import {Data} from 'parser/core/modules/Data'
import Downtime from 'parser/core/modules/Downtime'
import Suggestions, {SEVERITY, Suggestion, TieredSuggestion} from 'parser/core/modules/Suggestions'
import React from 'react'

const FORM_TIMEOUT_MILLIS = 15000

export const FORMS = [
	STATUSES.OPO_OPO_FORM.id,
	STATUSES.RAPTOR_FORM.id,
	STATUSES.COEURL_FORM.id,
]

const OPO_OPO_SKILLS = [
	ACTIONS.BOOTSHINE.id,
	ACTIONS.DRAGON_KICK.id,
	ACTIONS.ARM_OF_THE_DESTROYER.id,
]

export default class Forms extends Module {
	static override handle = 'forms'

	@dependency private combatants!: Combatants
	@dependency private data!: Data
	@dependency private downtime!: Downtime
	@dependency private suggestions!: Suggestions

	private formless: number = 0
	private resetForms: number = 0
	private skippedForms: number = 0
	private droppedForms: number = 0

	private lastFormChanged?: number
	private lastFormDropped?: number
	private perfectlyFresh?: number

	protected override init(): void {
		this.addEventHook('cast', {by: 'player'}, this.onCast)
		this.addEventHook('applybuff', {to: 'player', abilityId: FORMS}, this.onGain)
		this.addEventHook('refreshbuff', {to: 'player', abilityId: FORMS}, this.onGain)
		this.addEventHook('removebuff', {to: 'player', abilityId: FORMS}, this.onRemove)
		this.addEventHook('removebuff', {to: 'player', abilityId: this.data.statuses.PERFECT_BALANCE.id}, this.onPerfectOut)
		this.addEventHook('complete', this.onComplete)
	}

	private onCast(event: CastEvent): void {
		const action = this.data.getAction(event.ability.guid)

		if (!action) {
			return
		}

		if (action.onGcd) {
			// Check the current form and stacks, or zero for no form
			const currentForm = FORMS.find(form => this.combatants.selected.hasStatus(form)) || 0
			const untargetable = this.lastFormChanged != null
				? this.downtime.getDowntime(
					this.parser.fflogsToEpoch(this.lastFormChanged),
					this.parser.fflogsToEpoch(event.timestamp),
				)
				: 0

			if (action.id === this.data.actions.FORM_SHIFT.id) {
				// Only ignore Form Shift if we're in downtime
				if (untargetable === 0) {
					this.skippedForms++
				}

				return
			}

			// If we have PB/FS, we can just ignore forms
			if (
				this.combatants.selected.hasStatus(this.data.statuses.PERFECT_BALANCE.id) ||
				this.combatants.selected.hasStatus(this.data.statuses.FORMLESS_FIST.id)
			) { return }

			// Handle relevant actions per form
			switch (currentForm) {
			case this.data.statuses.OPO_OPO_FORM.id:
				break

			// Using Opo-Opo skills resets form
			case this.data.statuses.RAPTOR_FORM.id:
			case this.data.statuses.COEURL_FORM.id:
				if (OPO_OPO_SKILLS.includes(action.id)) { this.resetForms++ }
				break

			default:
				// Fresh out of PB, they'll have no form
				if (this.perfectlyFresh) {
					this.perfectlyFresh = undefined
					return
				}

				// Check if we timed out
				if (untargetable === 0 && this.lastFormDropped && this.lastFormChanged) {
					if ((this.lastFormDropped - this.lastFormChanged) > FORM_TIMEOUT_MILLIS) {
						this.droppedForms++
					}
				}

				// No form used
				if (OPO_OPO_SKILLS.includes(action.id)) {
					this.formless++
				}
			}
		}
	}

	// Anatman doesn't freeze, it just refreshes every tick, so it's the same as a gain
	private onGain(event: BuffEvent): void {
		this.lastFormChanged = event.timestamp
	}

	private onRemove(event: BuffEvent): void {
		this.lastFormDropped = event.timestamp
	}

	private onPerfectOut(event: BuffEvent): void {
		this.perfectlyFresh = event.timestamp
	}

	private onComplete(): void {
		// Using the wrong form
		this.suggestions.add(new TieredSuggestion({
			icon: this.data.actions.FORM_SHIFT.icon,
			content: <Trans id="mnk.forms.suggestions.formless.content">
				Avoid using combo starters outside of <StatusLink {...this.data.statuses.OPO_OPO_FORM}/> as the Form bonus is only activated in the correct form.
			</Trans>,
			tiers: {
				1: SEVERITY.MINOR,
				2: SEVERITY.MEDIUM,
			},
			value: this.formless,
			why: <Trans id="mnk.forms.suggestions.formless.why">
				<Plural value={this.formless} one="# combo-starter was" other="# combo-starters were" /> used Formlessly, cancelling form bonus effects.
			</Trans>,
		}))

		// Cancelling forms
		if (this.resetForms >= 1) {
			this.suggestions.add(new Suggestion({
				icon: this.data.actions.FORM_SHIFT.icon,
				severity: SEVERITY.MEDIUM,
				content: <Trans id="mnk.forms.suggestions.reset.content">
					Try not to cancel combos by using <ActionLink {...this.data.actions.BOOTSHINE}/>, <ActionLink {...this.data.actions.DRAGON_KICK}/>, or <ActionLink {...this.data.actions.ARM_OF_THE_DESTROYER}/> mid-rotation.
				</Trans>,
				why: <Trans id="mnk.forms.suggestions.reset.why">
					<Plural value={this.resetForms} one="# combo was" other="# combos were" /> reset by an Opo-Opo Form skill.
				</Trans>,
			}))
		}

		// Skipping a form
		if (this.skippedForms >= 1) {
			this.suggestions.add(new Suggestion({
				icon: this.data.actions.FORM_SHIFT.icon,
				severity: SEVERITY.MEDIUM,
				content: <Trans id="mnk.forms.suggestions.skipped.content">
					Avoid skipping Forms outside of downtime. A skipped GCD could otherwise be used for damage.
				</Trans>,
				why: <Trans id="mnk.forms.suggestions.skipped.why">
					<Plural value={this.skippedForms} one="# form was" other="# forms were" /> skipped by Form Shift unnecessarily.
				</Trans>,
			}))
		}

		// Form timeout
		if (this.droppedForms >= 1) {
			this.suggestions.add(new Suggestion({
				icon: this.data.actions.FORM_SHIFT.icon,
				severity: SEVERITY.MAJOR,
				content: <Trans id="mnk.forms.suggestions.dropped.content">
					Avoid dropping Forms. You may need to use a gap closer or stay closer to the enemy to avoid your combo timing out. This usually indicates a bigger problem.
				</Trans>,
				why: <Trans id="mnk.forms.suggestions.dropped.why">
					Form was dropped <Plural value={this.droppedForms} one="# time." other="# times." />
				</Trans>,
			}))
		}
	}
}
