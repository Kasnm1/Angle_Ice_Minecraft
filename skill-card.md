## Description: <br>
Local HTTP bridge for Mineflayer-based live control of a Minecraft Java bot — including
Forge/FML modded servers. Provides live state reads and in-game actions such as movement,
mining, crafting, following, combat, and chat. <br>

Ships an independent persona (**Angel_ICE**, see `PERSONA.md`) and a persistent on-disk
memory (`memory/journal.md`, `memory/state.json`) so the bot keeps continuity across
sessions and across different agents. <br>

Runs standalone with `node bridge-server.js`; configuration lives in `config.json`
(env vars override). Not tied to any particular agent runtime. <br>

## Publisher: <br>
Local fork of `minecraft-bridge` (original upstream: MIT-0). Extended with the Forge FML
login handshake, additional game-action endpoints, the persona layer, and the memory
subsystem. <br>

### License/Terms of Use: <br>
MIT-0 <br>

## Use Case: <br>
Connecting an agent-controlled bot to a live Minecraft Java world/server, inspecting live
bot state, and issuing bounded in-game actions through the local bridge. Also used as a
persona-driven companion that the player actually plays alongside. <br>

### Deployment Geography for Use: <br>
Local only — the bridge binds to `127.0.0.1` and must not be exposed publicly. <br>

## Known Risks and Mitigations: <br>
Risk: The local control API is unauthenticated and can issue live bot actions. <br>
Mitigation: Keep the bridge bound to localhost (default), do not expose the port, and stop
the bridge when it is no longer needed. <br>
Risk: The slash-command endpoint can change the world or other players' experience if the
bot has elevated permissions. <br>
Mitigation: Avoid granting operator or cheat-level permissions unless required. <br>
Risk: `memory/journal.md` accumulates chat content in plain text. <br>
Mitigation: It lives inside the skill directory — treat it as private data. <br>

## Reference(s): <br>
- [Persona — Angel_ICE](PERSONA.md) <br>
- [Minecraft Bridge API Specification](references/api-spec.md) <br>
- [Forge FML Login Handshake](references/forge-fml-handshake.md) <br>
- [Minecraft Bridge Dependency Guide](references/dependency-guide.md) <br>
- [Minecraft Bridge Troubleshooting](references/troubleshooting.md) <br>

## Skill Output: <br>
**Output Type(s):** [Guidance, Shell commands, Configuration, API calls] <br>
**Output Format:** [Markdown with inline shell commands, HTTP endpoint guidance, and JSON examples] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Produces local setup and runtime guidance for a Minecraft bridge; actions affect the connected game world when the bridge is running.] <br>

## Skill Version(s): <br>
1.1.0 (local fork: Forge handshake + persona + persistent memory) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
