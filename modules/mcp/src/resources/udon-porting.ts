export const UDON_PORTING_GUIDANCE = `
## SDK equivalents and unsupported behaviour
Identify the installed target SDK before choosing Visual Scripting units. Verify the component, event, port types and runtime support in that SDK. An Altspace Creator SDK equivalent is not automatically a Banter equivalent. If there is no verified equivalent, leave the candidate disabled and explain what is missing.

## Component identity and interaction
Follow the UdonSharp proxy to its backing UdonBehaviour and owning GameObject. Match that instance to the persisted target ScriptMachine, graph and interaction target. Names, hierarchy order and identical graph contents cannot distinguish multiple listeners on one object. Check the interaction prompt, range, permissions and enabled state separately.

## Saved values and prefab overrides
Read values on the actual scene or prefab instance, not just script or graph defaults. Preserve object references, overrides, active state and component enabled state. Distinguish a missing value from an explicitly stored zero, false or null. Compare after saving and reopening; do not overwrite the source to make a comparison pass.

## Working copies and shared assets
A working copy may retain the original world's upload destination and auto-upload preference. Check them in the copy before a build; do not upload as part of validation. Duplicated objects can still point at the same graph asset or persistent ID. For an independent instance, establish which references and IDs should be separate; for a linked display, sharing may be intentional. Back up affected graphs before replacing them and leave the original untouched.

## Custom events and argument count
Check both caller and receiver: target, event name, argument count (arity), order and types. A typed receiver body does not validate its caller. The reviewed Visual Scripting CustomEvent implementation can ignore extra arguments, and missing ones can fail before a guard in the graph runs. Verify the installed implementation; do not enable an unproven event path on the strength of a receiver guard.

## Lifecycle, ownership and multiplayer
Invoking a graph by hand does not show that its normal lifecycle will invoke it. A local effect is not proof of network authority or replication. Test with a non-owner, an ownership transfer and a late join. Check who may initiate the action, whether each client sees it once, and whether a rejoining client restores state instead of replaying the action. Keep Editor, installed-client and multiplayer results separate.
`.trim();
