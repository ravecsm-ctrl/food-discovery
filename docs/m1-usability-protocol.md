# M1 real-use usability check (ENG-019, M1 exit gate item 12)

Status: **not yet run.** This needs real people. It is a small, informal check that the interaction is understandable, not a statistical study.

## Setup
- 3–5 adults (you, plus a few willing friends or your partner), each on their own phone browser, using `http://<your-mac-LAN-IP>:3000` or a laptop.
- Before each person starts: Lab → "Rotate through all policies" (default). Do not tell them which policy they get.
- Before collecting any real meals, clear test data: Lab → "Clear all local prototype data".
- Tell participants that their reactions stay on the device and that dish information is general, not verified.

## Tasks (observe; don't help unless they're stuck for more than 30 s)
1. "Find something you'd like to eat tonight." Note whether they swipe, tap buttons, or use the keyboard, and how long they take to reach the results.
2. "Undo your last choice." Can they find Undo?
3. "Look at more information about a dish without choosing it." Can they find Details?
4. On the results screen: "Why do you think it suggested these?" Do the explanations make sense, and do they trust them?
5. "Pick one." Later, if they actually ate: "Tell the app what you ate." Can they find the confirmation prompt on the home screen?
6. Optional: set a dietary restriction and repeat task 1. Do they understand the "check before ordering" warnings?

## Record per session
- Policy (Lab → session list), cards to first results, whether a dish was selected, time to selection (from the export).
- Confusions, hesitations, verbatim quotes.
- Did a "Not tonight" ever feel permanent to them? Did choosing a dish feel like logging it as eaten?

## Exit questions
- "Was anything confusing?" · "Did the suggestions match your mood?" · "Would you use this again when undecided?"

Write findings to `docs/m1-usability-findings.md` before starting M2 (ETD §9.5 gate 12).
Export the Lab JSON for each device and keep it with the findings. It contains no names or restrictions.
