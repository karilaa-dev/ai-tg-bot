# OfficeCLI skills

The bot advertises two reviewed Pi skills:

- `officecli-docx` for Word files
- `officecli-pptx` for PowerPoint files

Both started from [`iOfficeAI/OfficeCLI`](https://github.com/iOfficeAI/OfficeCLI/tree/main/skills) commit `b2f30dd9eaa7459b4d5b5ecc2387402f8e01d412`. The local copies are adapted to this bot's preinstalled-tool and Browser Use preview rules, so they are no longer byte-for-byte upstream files.

`src/pi/officeSkills.ts` stores the hashes for the local Pi copies and checks them at startup. The test suite checks loading and read-tool isolation. `e2b-template/template.ts` separately pins the upstream OfficeCLI binary and the upstream skill copies installed inside the sandbox.

Review upstream changes before updating either pin. Update the relevant revision, hashes, tests, license material, and documentation together.
