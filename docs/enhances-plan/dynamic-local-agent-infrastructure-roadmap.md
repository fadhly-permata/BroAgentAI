# BroAgentAI — Dynamic Local Agent Infrastructure Roadmap

> Status: Proposed  
> Type: Architecture Enhancement Plan  
> Scope: Bridge, local execution, native shell abstraction, environment awareness, and agent capabilities  
> Last reviewed: 2026-11-22  
> Review status: EGM-lite architecture review incorporated; all review questions are resolved in §13, the prioritized execution backlog is in §14, and the AGENTS.md context contract is in §15.

## 1. Overview

This document defines the proposed architectural direction for evolving BroAgentAI from a tool-oriented browser-to-local bridge into a minimal, flexible, and extensible local agent infrastructure.

The primary objective is to reduce unnecessary native bridge operations while expanding the capabilities available to AI agents through the local execution environment.

The central architectural principle is:

**Minimal Core, Maximum Capability.**

Rather than implementing a dedicated bridge tool for every filesystem operation, Git command, or local utility, BroAgentAI should provide a reliable execution infrastructure that allows AI agents to use existing operating-system capabilities, runtimes, command-line utilities, scripts, and packages.

The bridge should focus on providing controlled access to the local environment, managing execution lifecycle, maintaining relevant context, and ensuring reliable communication between the browser and local machine.

## 2. Vision and Architectural Direction

### 2.1 From Tool Provider to Environment Gateway

The bridge should evolve from a collection of predefined operations into a gateway that exposes the local environment to AI agents.

Current conceptual model:

```text
AI Agent
   |
   v
BroAgentAI Bridge
   |
   +-- fs.readFile
   +-- fs.writeFile
   +-- fs.searchFiles
   +-- git.status
   +-- git.diff
   +-- git.commit
   +-- shell.run
```

Proposed conceptual model:

```text
AI Agent
   |
   v
BroAgentAI Bridge
   |
   +-- Communication Layer
   +-- Execution Engine
   +-- Environment Context
   +-- Session and Process Management
   +-- Security and Execution Policy
   +-- Result Normalization
   |
   v
Local Environment
   |
   +-- Native shells (PowerShell, cmd, bash, zsh, sh, ...)
   +-- Node.js / Python
   +-- Git CLI
   +-- npm Ecosystem
   +-- Existing CLI Utilities
   +-- Local Applications and Services
   +-- Custom Scripts
```

The AI agent determines how to accomplish a task. The bridge provides the infrastructure required to execute that task locally and return reliable results.

### 2.2 Core Architectural Principles

1. **Shell-first:** Use shell execution as the primary interface for local operations whenever practical.
2. **Minimal core:** Keep the bridge focused on essential infrastructure rather than duplicating operating-system functionality.
3. **Environment-native:** Prefer existing runtimes, utilities, CLI applications, and packages over custom bridge implementations.
4. **On-demand capability:** Discover and use additional capabilities when required instead of maintaining an unnecessarily large static tool catalog.
5. **No unnecessary wrappers:** Do not introduce bridge wrappers without a clear architectural or operational benefit.
6. **Context-aware, not context-heavy:** Provide relevant environment information on demand rather than continuously transmitting excessive context.
7. **Safe execution:** Maintain explicit execution boundaries, permissions, approval policies, and resource limits.
8. **Observable execution:** Every execution should have a reliable status, result, and diagnostic information.
9. **Recoverable workflow:** Support monitoring, cancellation, and recovery for long-running operations.
10. **AI-driven composition:** The AI agent is responsible for planning and composing workflows; the bridge provides execution infrastructure.
11. **Shell-aware execution:** Target a specific native shell family and execution environment; never assume command portability between shells.
12. **Automatic shell detection:** The bridge selects the shell family and execution environment from the platform and available tools. The agent observes the detected shell and targets it; the agent does not choose or switch shells.

## 3. Development Directions

### 3.1 Shell-Centric Bridge

**Priority: Critical**

Make `shell.run` the primary interface for local operations.

The goal is to reduce redundant native tools such as `fs.*` and `git.*` when equivalent operations can be performed through the local shell.

Examples:

| Operation | Preferred implementation |
|---|---|
| Read files | Available shell or Node.js |
| Write files | Available shell or Node.js |
| Edit files | Available shell, Node.js scripts, Python, or patch utilities |
| Search files | ripgrep, available shell, or other CLI utilities |
| List directories | Available shell or Node.js |
| Rename and move | Selected shell commands |
| Delete files | Selected shell commands |
| Git operations | Git CLI |
| JSON processing | Node.js or jq |
| Bulk processing | Node.js, Python, or available shell |
| Build and testing | Existing project scripts and CLI tools |

Node.js built-in modules should be preferred for routine programmatic filesystem operations when appropriate. Additional npm packages should only be introduced when they provide meaningful capabilities that are not already available.

Migration must be gradual. Existing operations should not be removed until equivalent workflows have been validated and dependent consumers have been migrated.

Shell selection is automatic and uses a documented platform priority. The agent is told which shell was detected and writes commands for that shell family; the bridge does not translate syntax between shells. See §3.2.

### 3.2 Shell Abstraction and Multi-Platform Execution

**Priority: Critical**

Shell execution must support the native shell families available on the user's operating system. The bridge must not assume that PowerShell, Bash, or any other single shell is universally present or syntactically compatible with the others.

A shell should be described by a small, data-driven registry entry rather than platform-specific branching. Each entry should define:

- Stable shell identifier and family (`posix-sh`, `bash`, `zsh`, `fish`, `pwsh`, `powershell`, `cmd`, ...).
- Executable path and how it was discovered.
- Argument construction for non-interactive command execution.
- Exit-code propagation strategy.
- Output encoding and decoding expectations.
- Profile and environment bootstrap policy.
- Working-directory and path translation rules.
- Process termination strategy.
- Availability and version information.

Two concepts must remain separate:

1. **Shell family** — the command language and execution contract (`bash`, `zsh`, `pwsh`, `cmd`, ...).
2. **Execution environment** — where the shell runs (native Windows, macOS, or Linux; later WSL, containers, or remote hosts).

A shell family does not imply an execution environment. WSL, Git Bash, containers, and remote hosts introduce different filesystem namespaces, path models, and process trees. They should be modeled as execution providers with explicit translation and lifecycle rules, not as ordinary shell names.

Required behavior:

- The bridge selects the shell automatically using a documented platform priority and bounded availability checks.
- Detection is deterministic and cached. The fallback order is documented per platform, and a missing primary shell produces a structured result rather than a silent switch to an incompatible shell.
- The agent receives the detected shell, its syntax expectations, and the available fallbacks for diagnostics before composing commands. The agent does not pass a shell parameter.
- Commands are never assumed to be portable across shell families.
- Shell-specific exit-code handling is implemented in the execution wrapper, not left to the command author.
- Output is decoded according to the detected shell's encoding.
- The working directory is translated when the execution environment requires it.
- Process termination accounts for the shell family and the platform process model.
- Shell profiles are not loaded for routine one-shot execution unless explicitly requested; environment bootstrap is handled separately and cached.
- Shell discovery is bounded and cached. Arbitrary executable paths supplied by an agent are not accepted; only discovered and allowlisted shells may be used.
- There is no user-level or workspace-level shell override. Automatic detection is the only source of shell selection; the agent cannot change it.

Initial supported scope:

| Platform | Shell families | Default behavior |
|---|---|---|
| Windows | `pwsh`, `powershell`, `cmd` | Prefer `pwsh` when available, then Windows PowerShell; `cmd` for compatibility |
| macOS | `zsh`, `bash`, `sh` | Use the user's login shell for interactive terminals; a documented non-interactive default for one-shot execution |
| Linux | `bash`, `sh`, `zsh` | Prefer `bash` when available, otherwise `sh` |

MVP scope (first implementation):

| Platform | Primary shell | Fallback | Post-MVP |
|---|---|---|---|
| Windows | `pwsh` | `powershell.exe` | `cmd` |
| macOS | `zsh` | `bash`, `sh` | fish, Nushell |
| Linux | `bash` | `sh` | `zsh` |

MVP means the smallest end-to-end implementation that proves automatic detection, shell-aware command execution, structured results, and approval on each supported platform. `cmd` is post-MVP because its quoting, exit-code, and encoding behavior adds a third shell contract; it must not block the first release.

Deferred until a concrete requirement exists:

- WSL and other non-native execution environments.
- Git Bash/MSYS path and process semantics on Windows.
- Fish, Nushell, and other non-POSIX shells.
- Persistent shell sessions for one-shot execution.

Persistent shell state (`cd`, environment changes, functions, aliases) must not be assumed between `shell.run` calls. Multi-step workflows should use explicit working directories, project scripts, or reviewable script files. Interactive state remains the responsibility of the terminal session.

Structured errors should distinguish at least:

- Detected shell is not installed or not allowlisted (`SHELL_NOT_AVAILABLE`).
- Shell failed to start (`SHELL_START_FAILED`).
- Shell family is unsupported by the bridge (`SHELL_UNSUPPORTED`).
- Working directory cannot be represented in the detected execution environment (`SHELL_CWD_INVALID`).

Agent-facing contracts should include a read-only shell information surface (for example `shell.info`, or fields in `system.info`) that reports the detected shell, its family, version, encoding, and fallbacks. `shell.run` does not take a shell parameter from the agent; its result reports the detected shell family, execution environment, exit status, and termination reason.

Because selection is automatic, approval and audit records bind to the detected shell, the starting working directory, and the command. If the detected shell changes, the approval key changes. This prevents shell switching from bypassing an approval that was granted for a different execution context. A detected shell change after a runtime or PATH update is shown in the UX as a banner and must be confirmed before the next command runs.

### 3.3 Execution Engine Maturity

**Priority: Critical**

Evolve shell execution beyond a simple command runner.

Required capabilities:

- Consistent command execution contract across supported shell families.
- Explicit working directory management and path translation.
- Explicit shell-family and execution-environment detection and reporting.
- Shell-family-specific argument construction and command wrapping.
- Accurate exit codes and termination reasons, including signals where the platform exposes them.
- Per-shell output encoding and decoding.
- Separate stdout and stderr.
- Configurable timeout.
- Output size limits and truncation metadata.
- Process identification and lifecycle tracking.
- Background process support.
- Persistent process sessions where required.
- Process cancellation and termination.
- Output streaming or controlled polling.
- Encoding and output normalization.
- Structured error reporting.

MVP execution contract (minimum):

- Every `shell.run` result includes an execution identifier, the detected shell family and execution environment, the starting working directory, the exit code, a termination reason, stdout, stderr, the decoding used, timeout status, truncation metadata, and duration.
- A running execution can be cancelled through a stable execution identifier.
- Concurrent `shell.run` executions are bounded, and excess work is queued or rejected with a structured error.
- Process-tree termination is verified on each MVP platform using the platform mechanism: Job Objects on Windows and process groups on POSIX where available. On Windows, if Job Objects are unavailable, execution is refused rather than run without reliable process-tree termination.

The execution engine should support both short commands and long-running tasks without forcing the AI agent to use different, unrelated execution mechanisms. The same contract should apply regardless of the detected shell family or execution environment.

### 3.4 Environment Awareness

**Priority: High**

The bridge should expose enough environment information for agents to select appropriate execution strategies.

Potential environment information:

- Operating system and architecture.
- Available shell families, executable paths, versions, and limitations.
- Default shell selection per platform and per workspace.
- Shell environment bootstrap information: PATH origin, profile policy, and output encoding.
- Node.js and npm versions.
- Python availability and version.
- Git availability and version.
- Installed command-line utilities.
- Workspace root and current working directory.
- Repository status and project structure when requested.
- Package manager detection.
- Project type and relevant configuration.
- Available execution providers and their path models.

Environment information should be discoverable on demand and cached only when cache invalidation can be handled reliably. Shell availability and environment bootstrap data are machine-level facts and should be cached separately from workspace-level facts.

The initial implementation should support the native shells of Windows, macOS, and Linux incrementally, validating each shell family on its platform rather than assuming portability.

### 3.5 Dynamic Capability Discovery

**Priority: High**

The agent should be able to discover available local capabilities without requiring every capability to become a dedicated bridge tool.

Potential discovery targets:

- Installed CLI utilities.
- Available runtimes.
- Available shell families and their capabilities.
- Package managers.
- Existing project scripts.
- Relevant npm packages.
- Python packages and utilities.
- Locally available applications.
- Optional providers and integrations.

A capability discovery process should generally follow this sequence:

1. Identify the operational requirement.
2. Check whether the environment already provides a suitable capability, including a suitable shell family and execution environment.
3. Evaluate available alternatives.
4. Select the most appropriate implementation.
5. Install additional dependencies only when justified.
6. Execute through the supported bridge execution mechanism using the detected shell and environment.
7. Validate the result and report any limitations.

Capability discovery should not automatically become a registry containing every available command. It should provide useful information only when required.

### 3.6 Security and Execution Control

**Priority: Critical**

Centralizing operations through shell increases flexibility but also expands the potential impact of execution mistakes.

Security must therefore be designed as a first-class responsibility of the bridge.

Areas to address:

- Workspace and working-directory boundaries.
- Execution permissions and approval policies.
- Risk classification for potentially destructive operations.
- Shell executable allowlisting and validation.
- Shell profile and startup-file execution policies.
- Execution-environment boundaries and path translation.
- Process and resource limits.
- Timeout enforcement.
- Environment variable handling.
- Protection of credentials and sensitive output.
- Dependency installation policies.
- Execution auditing.
- Cancellation and termination controls.

Important considerations:

- Shell access must not be considered safe merely because it is exposed through a single tool.
- Command-string filtering alone is insufficient as a security boundary.
- Workspace restrictions must account for shell behavior, child processes, symbolic links, and alternate execution paths.
- A shell identifier must never be accepted as an arbitrary executable path.
- Shell profiles can execute user code and must not be loaded implicitly for routine one-shot commands.
- Approval and auditing must bind to the shell and working directory, not only the command string.
- npm packages and external utilities introduce supply-chain risks.
- Existing approval behavior should remain predictable.

MVP security position:

- Workspace confinement applies to the starting working directory, not to everything the command can reach. A shell command runs with the bridge process's privileges and can leave the workspace. The MVP must state this explicitly and must not describe the bridge as a sandbox.
- The approval interaction lives in the UX: the UI shows the detected shell, starting working directory, command, and risk; the backend computes the approval key and enforces the decision.
- The MVP reuses the existing approval modes (`read-only`, `always-ask`, `ask-once`, `auto-approve`). It does not add a new policy engine.
- Approval and audit keys bind to the detected shell, starting working directory, and command. The agent cannot select a different shell to obtain a broader approval.
- There is no terminal shell override. The agent cannot select or change a shell; automatic detection is the only source of shell selection.

The security model must reflect the actual execution privileges available to the local bridge process.

### 3.7 Reliability and Observability

**Priority: High**

Agents need reliable information about what happened during execution.

The bridge should provide:

- Structured execution results.
- Selected shell family, execution environment, and termination reason.
- Consistent error categories.
- Process health information.
- Execution duration.
- Timeout and cancellation status.
- Output truncation indicators.
- Diagnostic information where available.
- Operational logs.
- Bridge health checks.
- Failure reporting and recovery signals.

The MVP result contract must include the detected shell, execution environment, execution identifier, process identifier where available, exit code, termination reason, encoding, timeout and cancellation status, truncation metadata, and duration. A boolean `truncated` flag alone is insufficient once output continuation or artifact access is supported.

Where appropriate, execution failures should include structured classifications such as:

- Command not found.
- Shell not available.
- Shell failed to start.
- Unsupported shell family or execution environment.
- Permission denied.
- Dependency error.
- Invalid working directory.
- Timeout.
- Process terminated.
- Runtime failure.
- Non-zero exit code.
- Output or communication failure.

The bridge should provide diagnostics without attempting to replace the reasoning and decision-making responsibilities of the AI agent.

### 3.8 Context, Session, and Task Continuity

**Priority: Medium-High**

Support reliable execution across multiple interactions and long-running tasks.

Potential session information:

```text
Session
  +-- Session ID
  +-- Task ID
  +-- Workspace Context
  +-- Environment Context
  +-- Active Processes
  +-- Execution History
  +-- Execution Artifacts
  +-- Cancellation State
  +-- Recovery State
```

Required development areas:

- Session identification.
- Process-to-session association.
- Execution history.
- Task state tracking.
- Active process monitoring.
- Workspace context management.
- Cancellation state.
- Recoverable execution state.
- Resume support where technically feasible.

The initial implementation should prioritize process lifecycle consistency and task state tracking before introducing more elaborate persistence mechanisms.

### 3.9 Agent Workflow and Autonomy

**Priority: Medium**

Once the execution foundation is stable, BroAgentAI can support more advanced agent workflows.

Potential capabilities:

- Multi-step execution.
- Sequential and conditional operations.
- Dependency-aware execution.
- Validation loops.
- Controlled retries.
- Error-driven recovery.
- Workflow progress reporting.
- Task completion verification.
- Dynamic selection of available shells, execution environments, and capabilities.

Example workflow:

```text
User Request
     |
     v
Task Planning
     |
     v
Environment Discovery
     |
     v
Capability Selection
     |
     v
Execution
     |
     v
Validation
     |
     +---- Success ----> Completion Report
     |
     +---- Failure ----> Diagnosis
                              |
                              v
                         Recovery Plan
                              |
                              v
                          Execution
```

The AI agent should remain responsible for reasoning and deciding how to recover from failures. The bridge should provide the execution state, diagnostics, and control mechanisms needed to support those decisions.

## 4. Proposed Development Roadmap

Development should proceed incrementally, with each phase establishing the foundation for the next.

### Phase 0 — Safety, Approval, and MVP Baseline

**Objective:** Establish the minimum security, approval, and observability contracts before adding shell coverage.

Tasks:

- Define the trust model and state explicitly that workspace confinement is not a sandbox.
- Make shell detection automatic and deterministic; expose the detected shell to the agent without giving the agent a shell parameter.
- Bind approval and audit keys to the detected shell, starting working directory, and command.
- Define the MVP shell matrix and its test fixtures.
- Add the minimum execution result contract: execution identifier, detected shell, execution environment, exit code, termination reason, encoding, timeout, truncation, and duration.
- Keep the typed filesystem and Git primitives; document which operations remain native and why.
- Remove the arbitrary terminal shell override; automatic shell detection is the only source of shell selection.
- Add bounded concurrency, cancellation, and process-tree cleanup requirements.
- Add protocol and UX notes for showing the detected shell and approval context.

Expected outcome:

A small, testable safety and observability baseline that the first shell implementations can rely on.

### Phase 1 — Simplify the Bridge

**Objective:** Reduce redundant native operations and establish shell-first architecture.

Tasks:

- Inventory existing bridge tools and their consumers.
- Identify operations replaceable through shell commands or existing runtimes.
- Define the minimal set of essential bridge primitives.
- Standardize the shell execution contract.
- Define the MVP shell matrix, automatic detection priority, and per-shell execution contracts.
- Migrate only long-tail filesystem workflows to shell-based alternatives; retain typed filesystem primitives where they preserve confinement, structured results, or safety.
- Use the Git CLI for long-tail Git operations while retaining the structured Git tools that enforce repository safety rules.
- Verify compatibility with existing agent workflows.
- Remove a native tool only after the replacement preserves workspace confinement, structured results, safety guarantees, and measured performance. A shell replacement must be equal to or faster than the native tool; never slower.

Expected outcome:

A smaller bridge with automatic shell detection across the MVP matrix, shell execution as the primary interface for long-tail operations, and typed primitives retained where they preserve safety or structure.

### Phase 2 — Strengthen the Execution Engine

**Objective:** Make local execution reliable for both short and long-running tasks across supported shell families.

Tasks:

- Improve execution result contracts.
- Implement shell-family-specific exit-code, encoding, and termination behavior.
- Implement or refine process tracking.
- Support background processes.
- Introduce persistent sessions where needed.
- Improve timeout and cancellation behavior, including cancellation through a stable execution identifier.
- Add bounded concurrency and admission control for `shell.run` executions.
- Improve output handling, truncation reporting, and controlled output continuation or artifact access.
- Normalize execution errors.
- Implement platform-appropriate process-tree termination, including Job Objects on Windows and process groups on POSIX where available. Refuse execution on Windows if Job Objects are unavailable.
- Validate process cleanup, resource handling, and orphan prevention.

Expected outcome:

A reliable execution engine capable of managing different execution lifecycles.

### Phase 3 — Environment Awareness

**Objective:** Enable agents to understand the local environment.

Tasks:

- Implement environment discovery.
- Detect installed runtimes and utilities.
- Identify available shell families through automatic detection, executable paths, and environment bootstrap requirements.
- Cache shell detection and environment bootstrap data with explicit invalidation and a manual refresh path.
- Bound discovery so it is not an exhaustive scan; treat the result as diagnostics rather than an authority.
- Protect discovery output from exposing credentials or unrelated user state.
- Detect project and package manager information.
- Provide workspace context on demand.
- Define environment information contracts.
- Handle unavailable or changing environment dependencies.

Expected outcome:

Agents can select suitable execution strategies based on actual environment conditions.

### Phase 4 — Dynamic Capability Discovery

**Objective:** Allow agents to discover and use additional local capabilities.

Tasks:

- Design lightweight capability discovery.
- Discover available CLI tools and runtimes.
- Inspect existing project scripts.
- Evaluate available package utilities.
- Define dependency installation policies: existing capabilities first, then temporary isolated execution, then persistent installation only with explicit approval and recorded side effects.
- Support optional execution providers where justified.
- Avoid unnecessary static capability catalogs.
- Never auto-install an arbitrary package merely because a command is unavailable.

Expected outcome:

Agent capabilities can expand through the local environment without continuously expanding the bridge API.

### Phase 5 — Context, Session, and Recovery

**Objective:** Improve continuity and reliability across complex tasks.

Tasks:

- Implement consistent session tracking.
- Associate processes with sessions and tasks.
- Track execution history.
- Maintain relevant workspace context.
- Keep execution history bounded; discard temporary audit records as soon as the session or debug work is finished, and redact sensitive output automatically before display or storage.
- Improve process recovery and cleanup.
- Support task resumption where feasible.

Expected outcome:

More stable long-running tasks and better continuity across agent interactions.

### Phase 6 — Autonomous Workflow

**Objective:** Support sophisticated multi-step agent execution.

Tasks:

- Develop workflow composition strategies.
- Support conditional execution.
- Introduce controlled retry mechanisms.
- Integrate validation and diagnostic feedback.
- Support error-driven recovery.
- Improve workflow progress and completion reporting.
- Validate execution boundaries across composed workflows.

Expected outcome:

BroAgentAI provides a reliable infrastructure for agents capable of executing and validating complex tasks.

## 5. Features and Approaches to Avoid

To preserve architectural simplicity, the following approaches should generally be avoided:

| Approach | Reason |
|---|---|
| A dedicated bridge tool for every filesystem operation | Redundant with shell and runtime capabilities |
| A dedicated bridge tool for every Git command | Git CLI already provides the required interface |
| A wrapper for every npm package | Creates unnecessary maintenance overhead |
| A hardcoded registry of every possible command | Defeats dynamic capability discovery |
| Installing packages for simple operations | Creates unnecessary dependencies and supply-chain exposure |
| Duplicating AI reasoning inside the bridge | Blurs responsibility boundaries |
| Excessive abstraction layers | Increases complexity without sufficient value |
| Unrestricted execution without policy | Creates excessive security and operational risk |
| Assuming one shell syntax works across platforms | Shell families have incompatible syntax, quoting, and exit-code behavior |
| Bundling a shell runtime when native shells exist | Increases install size and duplicates operating-system capabilities |
| Accepting arbitrary shell executable paths from an agent | Expands the attack surface and bypasses shell allowlisting |
| Treating workspace confinement as a security sandbox | Shell commands inherit the bridge process's privileges and can leave the workspace |
| Letting the agent choose or switch the shell | Detection must stay automatic so shell switching cannot bypass approval or produce untestable command contracts |

Guiding principle:

**No wrapper without a reason.**

A dedicated bridge capability should only be introduced when it provides a meaningful advantage in security, lifecycle management, performance, compatibility, observability, or user experience that cannot be adequately achieved through the existing execution infrastructure.

## 6. Architectural Boundaries and Responsibilities

### AI Agent Responsibilities

- Understand user requests.
- Plan tasks.
- Select commands and utilities for the detected shell family.
- Compose execution workflows.
- Interpret execution results.
- Diagnose failures.
- Decide recovery strategies.
- Verify task completion.

### Bridge Responsibilities

- Maintain browser-to-local communication.
- Detect the shell automatically and execute commands through the detected native shell and execution environment.
- Manage process and session lifecycle.
- Provide relevant environment context.
- Enforce execution policies.
- Normalize results and errors.
- Provide execution observability.
- Support cancellation and recovery mechanisms.

### Local Environment Responsibilities

- Provide filesystem operations.
- Provide version control utilities.
- Provide programming runtimes.
- Provide package management.
- Provide project build and test tools.
- Provide operating-system functionality.
- Provide optional external utilities and services.

This separation should remain consistent throughout future development.

## 7. Success Criteria

The proposed architecture should be evaluated against measurable outcomes.

### Bridge Simplification

- Redundant filesystem and Git operations are reduced or removed after successful migration.
- The number of bridge-specific operation implementations decreases.
- Existing essential communication functionality remains stable.

### Execution Reliability

- Short and long-running commands are supported reliably.
- Timeout and cancellation behavior is predictable.
- Process cleanup is verified.
- Exit codes and output are accurately reported.
- Errors are consistently structured.

### Environment Adaptability

- Agents can identify available shell families, runtimes, and utilities.
- Different project types can be handled without introducing project-specific bridge tools.
- Missing utilities can be identified before execution.

### Multi-Shell Execution

- The bridge detects the shell automatically using a documented, deterministic priority.
- The detected shell and execution environment are visible in execution results; the agent does not choose a shell.
- Exit codes, output encoding, working directories, and termination behave correctly for each MVP shell.
- Missing or unsupported shells produce structured errors rather than generic failures.
- Approval and auditing remain bound to the detected shell, starting working directory, and command. A detected shell change after a runtime or PATH update is confirmed in the UX before the next command.
- The MVP matrix is validated on each supported platform before additional shells are added.

### Capability Extensibility

- Additional local capabilities can be used without modifying the bridge core in ordinary cases.
- Dependency installation is controlled and justified.
- The architecture does not depend on a large hardcoded command catalog.

### Security and Stability

- Execution privileges and boundaries are explicit.
- Sensitive operations remain subject to applicable policies.
- Long-running tasks can be monitored and terminated.
- Failures do not leave uncontrolled background processes.

### Workflow Quality

- Multi-step tasks can be executed and validated consistently.
- Failure information supports meaningful recovery decisions.
- Task completion reports reflect actual execution results.

### MVP Completion

- One primary shell per platform and its documented fallback pass the exit-code, encoding, cwd, timeout, cancellation, and cleanup tests.
- The agent receives the detected shell and can write correct commands without a shell-selection parameter.
- Approval UX shows the detected shell, working directory, command, and risk.
- Typed filesystem and Git primitives remain available for operations where they preserve confinement or safety.
- Concurrent execution, cancellation, and process-tree cleanup are bounded and tested.

## 8. Migration Strategy and Compatibility

This roadmap should be implemented without destabilizing existing BroAgentAI functionality.

Recommended migration rules:

1. Inventory existing tools and all known consumers before removing or changing their contracts.
2. Identify functional parity between existing operations and shell-based alternatives.
3. Migrate consumers incrementally.
4. Preserve compatibility where required during transition.
5. Add tests for replacement workflows before removing existing implementations.
6. Keep browser-to-bridge communication stable unless a protocol change is explicitly justified.
7. Validate type safety, tests, and build behavior after each meaningful change.
8. Document intentional breaking changes.
9. Avoid combining large architectural migrations with unrelated feature work.
10. Introduce shell families incrementally and validate each one on its target platform before declaring multi-shell support complete.
11. Do not remove a typed filesystem or Git primitive until its shell replacement preserves workspace confinement, structured results, safety guarantees, and measured performance, and is equal to or faster than the native tool.
12. Keep shell selection automatic. There is no user-level or workspace-level override; the agent cannot change the detected shell.
13. Version the protocol and UX together when adding detected-shell metadata, approval context, or new execution controls.
14. Ship the MVP matrix before adding `cmd`, fish, Nushell, WSL, or other execution environments.

The existing development workflow and repository conventions must continue to be respected.

## 9. Non-Goals

This roadmap does not intend to:

- Turn the bridge into a complete operating-system abstraction framework.
- Support every shell family or non-native execution environment from the first implementation.
- Translate commands between shell families.
- Reimplement existing shell, Git, Node.js, or Python functionality.
- Build an independent AI reasoning engine inside the bridge.
- Introduce a complex plugin framework before a concrete need exists.
- Automatically install arbitrary packages without appropriate controls.
- Replace every existing bridge operation immediately.
- Make unrestricted autonomous execution the default behavior.

Complexity should only be introduced when supported by a clear use case and measurable benefit.

## 10. Final Architectural Vision

BroAgentAI should evolve into a lightweight local agent infrastructure that exposes the capabilities of the user's environment through a reliable and controlled execution layer.

Its long-term value should not come from the number of native tools it implements, but from the leverage it provides to AI agents.

The intended evolution is:

```text
Tool-Oriented Bridge
        |
        v
Shell-Centric Bridge
        |
        v
Reliable Execution Engine
        |
        v
Environment-Aware Infrastructure
        |
        v
Dynamic Capability Utilization
        |
        v
Context-Aware and Recoverable Execution
        |
        v
Autonomous Agent Workflow Infrastructure
```

The ultimate design principle is:

**Keep the bridge small. Make execution reliable. Let the environment provide capabilities. Let the AI compose them.**

This roadmap serves as the architectural direction for future BroAgentAI enhancements. Individual implementation decisions should be evaluated against these principles rather than introducing features solely to increase the number of available tools.

## 11. Risk Mitigation and Architectural Refinements

This section extends the roadmap with concrete safeguards and design decisions addressing the operational risks of a shell-first architecture. The objective is to preserve the flexibility of universal local execution without turning the bridge into an unrestricted or unreliable command launcher.

### 11.1 Shell-First, Not Shell-Only

Shell execution should be the default interface for general-purpose local operations, but it must not become an absolute requirement for every capability.

The MVP keeps typed filesystem and Git primitives for operations where they provide confinement, structure, or safety; shell execution covers the long tail. A native capability is replaced only when the replacement preserves those guarantees and is measurably acceptable.

Shell-first also does not mean shell-family-neutral: every execution targets a specific shell family with its own syntax, exit-code, encoding, and process behavior.

A specialized native bridge capability may remain or be introduced when it provides a demonstrable advantage that shell execution cannot adequately provide.

Valid reasons include:

- Browser and native-messaging lifecycle integration.
- Structured communication with browser tabs or extension components.
- Process supervision and cancellation guarantees.
- Security enforcement that must not depend on AI-generated command strings.
- Strongly typed, event-driven interactions.
- Performance or compatibility requirements that cannot be met adequately through shell execution.

Every exception should document its purpose, limitations, and why the existing execution infrastructure is insufficient. Avoid recreating ordinary filesystem, Git, or package-manager wrappers without a measurable benefit.

### 11.2 Execution Profiles

Introduce execution profiles to make execution behavior explicit and consistent across different task types.

An execution profile may define:

- Allowed shell families, runtimes, and execution environments.
- Default working directory and permitted workspace scope.
- Environment-variable inheritance and filtering rules.
- Timeout and resource limits.
- Output limits and encoding expectations.
- Approval requirements and risk classification.
- Background execution and process-lifecycle behavior.

Initial profiles may include:

| Profile | Intended use | Default characteristics |
|---|---|---|
| Standard | Routine development commands | Workspace-scoped, bounded execution |
| Read-oriented | Inspection and diagnostics | Minimize mutation permissions where enforceable |
| Build and test | Build tools, tests, linters | Longer timeout and controlled output |
| Elevated or sensitive | Destructive or privileged operations | Explicit approval and stricter controls |

Profiles are policy configurations, not claims of operating-system sandbox isolation. Their enforcement must be implemented at the process and operating-system boundary wherever possible.

The MVP does not require execution profiles. It uses the existing four approval modes and the UX approval flow. Profiles are a post-MVP refinement for teams that need reusable policy presets; they must not be presented as sandbox guarantees.

Profiles may restrict which shell families and execution environments are available. A profile must not silently fall back to a more permissive shell or environment when the requested one is unavailable.

### 11.3 Structured Script Execution Strategy

Complex operations should not require excessively long or fragile inline command strings.

The execution infrastructure should support a structured strategy for running scripts:

1. Use a short direct command for simple operations.
2. Use an existing project script when it already represents the required operation.
3. Use an appropriate runtime with a temporary or workspace-scoped script for complex multi-step operations.
4. Use a persistent script file when the operation must be reviewed, reused, tested, or maintained.
5. Capture the script's exit code, stdout, stderr, duration, and relevant artifacts as structured execution results.

Scripts must declare their shell family and are executed only by a compatible detected shell. A script written for Bash must not be executed through PowerShell or `cmd` merely because the detected default changed. Portable multi-step operations should prefer runtime scripts or project-defined commands over shell-specific syntax.

Script creation and execution must follow the same workspace, permission, approval, and cleanup policies as direct commands. Temporary scripts should use predictable lifecycle management, record which shell executed them, and must not be silently left behind after completion.

### 11.4 Dependency and Package Management Strategy

Dynamic capability utilization must not lead to uncontrolled dependency installation.

Use the following preference order:

1. Operating-system and shell built-in capabilities.
2. Built-in APIs from an already available runtime, such as Node.js standard modules.
3. Utilities and packages already installed in the environment.
4. Existing project dependencies and scripts.
5. Temporary, isolated dependency execution when appropriate and supported.
6. Persistent dependency installation only when there is a clear and justified need.

Before adding a dependency, the agent should evaluate its purpose, source, maintenance status, compatibility, installation side effects, and whether an existing capability is sufficient.

Dependency installation policies should distinguish between:

- Existing dependencies that can be used without modification.
- Temporary dependencies that do not alter the project manifest or lockfile.
- Project dependencies that intentionally modify project configuration.
- Global installations that affect the wider machine and therefore require stricter controls.

The bridge should expose installation outcomes and relevant changes. It should not silently install arbitrary packages merely because a command is unavailable.

### 11.5 Execution Isolation and Security Boundaries

A workspace path or command-string filter alone is not a sufficient security boundary for arbitrary shell execution.

The security design should progressively address:

- Process identity and inherited privileges.
- Workspace access and filesystem permissions.
- Symbolic links, junctions, and path traversal.
- Shell executable allowlisting and validation.
- Shell profile and startup-file execution.
- Path translation and filesystem boundaries in non-native execution environments.
- Child-process creation and process-tree termination.
- Network access and external downloads.
- Environment-variable and credential exposure.
- Resource consumption and execution duration.
- Temporary files and generated artifacts.
- Access to locations outside the intended workspace.

Shell selection is part of the security boundary. An agent must not be able to choose an arbitrary executable as a shell, and changing the shell or execution environment must not bypass approval, workspace, or auditing rules.

Where stronger isolation is required, evaluate operating-system facilities or dedicated sandbox mechanisms rather than relying solely on prompt instructions or command inspection.

The bridge must clearly distinguish policy checks from actual isolation guarantees. It must not report an execution as sandboxed unless the relevant enforcement is active and verified.

The MVP security contract is explicit about limits:

- Workspace confinement constrains the starting working directory; it does not constrain everything the command can reach.
- The approval UX shows the detected shell, starting working directory, command, and risk.
- The backend binds approvals to the detected shell, starting working directory, and command.
- The agent cannot select or switch the shell.
- The bridge does not claim sandbox isolation unless an OS-level isolation mechanism is active and verified.

### 11.6 Output Contracts and Failure Handling

All execution modes should return a consistent result contract, regardless of the detected shell or runtime.

The contract should include, where applicable:

- Execution identifier.
- Process or session identifier.
- Selected shell family and execution environment.
- Exit code and termination reason, including signal information where available.
- Standard output and standard error.
- Output encoding used for decoding.
- Execution duration.
- Completion, timeout, or cancellation status.
- Output truncation indicators.
- Failure category and diagnostic details.
- Artifact references when outputs are stored separately.

The MVP result contract must include the execution identifier, detected shell family, execution environment, starting working directory, exit code, termination reason, encoding, timeout and cancellation status, truncation metadata, and duration. A boolean truncation flag is not sufficient once output continuation or artifact access exists.

Large outputs should be bounded and retrievable through controlled continuation or artifact access rather than being silently discarded or sent without limits.

The bridge should distinguish command failure, runtime failure, timeout, cancellation, process termination, and communication failure so the agent can select an appropriate recovery strategy.

### 11.7 Performance Benchmarking

Architectural migration should be evaluated using measurements rather than assumptions that shell execution is always faster or more efficient.

Benchmark representative workloads across existing native operations and proposed shell-based replacements.

Suggested workloads:

- Reading and writing small files.
- Searching large directory trees.
- Processing multiple files in bulk.
- Reading and modifying structured JSON.
- Git status and diff operations.
- Running project tests and builds.
- Handling large command outputs.
- Starting, monitoring, and cancelling long-running processes.
- Shell startup and command execution across supported shell families.

Evaluate:

- End-to-end execution latency.
- Per-shell startup and execution overhead.
- Number of bridge round trips.
- Output size and token overhead.
- Memory and CPU consumption where measurable.
- Failure rate and recovery behavior.
- Implementation and maintenance complexity.

Retain a specialized native capability when measurements or operational requirements demonstrate a meaningful advantage. Do not preserve it merely because it already exists.

### 11.8 Cross-Platform and Multi-Shell Execution Strategy

Multi-shell execution is a first-class design requirement, not a later porting exercise. The bridge must run commands through the native shells available on the user's operating system and must not assume that one shell family is universally present or syntactically compatible with another.

The design separates:

- **Shell family** — the command language and execution contract (`bash`, `zsh`, `pwsh`, `cmd`, ...).
- **Execution environment** — where the shell runs (native Windows, macOS, or Linux; later WSL, containers, or remote hosts).

A shell family does not imply an execution environment. Git Bash and WSL on Windows, for example, introduce different filesystem namespaces, path models, process trees, and performance characteristics. They should be treated as execution providers with explicit path translation and lifecycle rules, not as drop-in shell names.

Implementation requirements:

- Discover available shells through bounded, cached checks rather than exhaustive scans.
- Validate and allowlist shell executables; never accept an arbitrary path as a shell identifier.
- Select the shell automatically using a documented priority per platform. The agent does not choose or switch shells.
- Provide the agent with the detected shell, its syntax expectations, and the available fallbacks for diagnostics.
- Implement exit-code propagation, output decoding, profile policy, working-directory translation, and process termination per shell family.
- Keep one-shot execution stateless; do not rely on shell state between calls.
- Validate each MVP shell and platform combination rather than assuming portability.
- Treat `cmd` as post-MVP; do not let its quoting and encoding complexity block the first release.

The initial scope should prioritize native shells:

| Platform | Initial shell families |
|---|---|
| Windows | `pwsh`, Windows PowerShell, `cmd` |
| macOS | `zsh`, `bash`, `sh` |
| Linux | `bash`, `sh` |

The MVP matrix is narrower than the initial scope: Windows `pwsh` with `powershell.exe` fallback; macOS `zsh` with `bash`/`sh` fallback; Linux `bash` with `sh` fallback. `cmd` is post-MVP.

Additional shells and execution environments should be added only when a concrete workflow requires them and the corresponding path, encoding, security, and lifecycle behavior can be validated. Cross-platform support must be proven on each supported environment, not inferred from a platform-neutral API.

### 11.9 Failure Recovery and Process Supervision

Process management should be treated as a core infrastructure responsibility.

The execution engine should:

- Track process ownership and association with a task or session.
- Detect process completion and unexpected termination.
- Terminate process trees according to the platform and detected shell family.
- Account for shells that create new process groups or detach from the original tree.
- Prevent orphaned background processes where feasible.
- Preserve enough execution metadata, including shell and environment, to diagnose failures.
- Use platform-appropriate process-tree termination: Job Objects on Windows where available, process groups on POSIX where available, and shell-specific cleanup for wrappers that detach children. On Windows, refuse execution when Job Objects are unavailable rather than risk orphaned processes.
- Bound the number of concurrent executions and apply backpressure or admission control.
- Expose cancellation through a stable execution identifier and report the termination reason.
- Keep execution history bounded, discard temporary audit records when the session or debug work is finished, and redact sensitive output automatically before display or storage.
- Distinguish safe retries from operations that may have partially changed state.

Retries must not be automatic for non-idempotent or destructive operations unless the agent has established that retrying is safe or the user has authorized it.

### 11.10 Acceptance Gates for Architectural Migration

Each migration phase should satisfy explicit acceptance conditions before the next phase depends on it.

| Area | Acceptance condition |
|---|---|
| Shell execution | Stable execution contract with accurate exit status and output handling |
| Shell abstraction | Shell discovery, selection, allowlisting, and per-shell contracts are documented and tested |
| Shell matrix | Every supported shell family passes exit-code, encoding, cwd, timeout, and cleanup tests |
| Process lifecycle | Timeout, cancellation, and cleanup behavior verified |
| Security | Execution privileges and policy boundaries documented and tested |
| Environment discovery | Missing and available shells and runtimes are detected reliably |
| Dependency management | Installation side effects are visible and controlled |
| Compatibility | Existing consumers are migrated and regression tests pass |
| Performance | Shell replacement is equal to or faster than the native operation in representative benchmarks |
| Recovery | Failure states are distinguishable and unsafe retries are prevented |
| Automatic detection | Detected shell is deterministic, reported to the agent, and cannot be changed by the agent |
| Approval context | Approval key binds detected shell, starting cwd, and command; UX shows all three |
| MVP shell matrix | Primary and fallback shells pass exit-code, encoding, cwd, timeout, cancellation, and cleanup tests |
| Typed primitive retention | All filesystem and Git primitives remain native after MVP; removal requires an explicit decision and a shell replacement that is equal to or faster |
| Concurrency and backpressure | Concurrent executions are bounded and excess work is queued or rejected predictably |

A phase should not be considered complete solely because its code has been implemented. Its acceptance conditions must be validated through tests or documented operational evidence.

## 12. Refined Architectural Decision

The target direction is **Shell-First, Minimal-Core, Controlled Execution**.

This decision establishes the following rules:

1. Native shells are the primary interface for general-purpose local operations. The bridge detects the shell family and execution environment automatically; the agent observes and targets the detected shell rather than choosing one.
2. The bridge remains responsible for communication, execution lifecycle, security enforcement, session management, and observability.
3. Specialized native capabilities are retained only when they provide a justified infrastructure advantage.
4. Environment discovery informs capability selection; it does not require a registry of every possible command.
5. Existing runtime and project dependencies are preferred over unnecessary installations.
6. Complex operations use reviewable scripts or project workflows instead of fragile command strings.
7. Execution profiles define consistent operational policies without overstating isolation guarantees.
8. Migration is incremental and driven by compatibility, security, reliability, and measured performance.
9. The AI agent composes and reasons about workflows, while the bridge enforces execution boundaries and reports verifiable outcomes.
10. Shell execution is shell-aware: the shell family and execution environment are explicit, and per-shell contracts are enforced rather than assumed.
11. Approval, auditing, and workspace boundaries bind to the detected shell, starting working directory, and command text.
12. The MVP supports one primary shell per platform with a documented fallback. `cmd` and additional shells are post-MVP.
13. All typed filesystem and Git primitives remain native after the MVP. Removal requires an explicit decision and a shell replacement that preserves confinement, structured results, safety guarantees, and is equal to or faster.
14. Workspace confinement is a starting-directory boundary, not a sandbox; the bridge must not claim isolation it does not enforce.
15. Protocol v2 introduces detected-shell metadata and approval context; v1 remains recognized but deprecated.

The refined architectural principle is:

**Keep the bridge minimal, not powerless. Make native shell execution universal, not unrestricted. Let the environment provide capabilities, and let the bridge guarantee controlled execution.**

## 13. Review Findings, Decisions, and MVP

This section records the EGM-lite architecture review performed on 2026-11-22 and the decisions taken in response. It is the short memory of what must not be forgotten.

### 13.1 Decisions

1. Shell selection is automatic. The bridge detects the platform and available shells, applies a documented priority, and reports the detected shell to the agent. The agent does not choose or switch shells, and there is no user-level or workspace-level override.
2. Approval is a UX interaction backed by host enforcement. The UX shows the detected shell, starting working directory, command, and risk. The backend computes and checks the approval key.
3. Approval and audit keys bind to the detected shell, starting working directory, and command, not the command alone.
4. The MVP does not add a new policy engine. It uses the existing approval modes and the UX flow.
5. All typed filesystem and Git primitives remain native after the MVP. A shell replacement may be adopted only after an explicit decision, and only if it preserves confinement, structured results, safety, and is equal to or faster than the native tool.
6. Workspace confinement is not a sandbox. The bridge must state this explicitly and must not claim isolation it does not enforce.
7. Temporary audit records are discarded as soon as the session or debug work is finished. Sensitive output such as tokens, passwords, API keys, and authorization headers is redacted automatically before display or storage.
8. Protocol v2 introduces detected-shell metadata and approval context. Protocol v1 remains recognized but deprecated.
9. On Windows, process-tree termination uses Job Objects. If Job Objects are unavailable, execution is refused rather than run without reliable cleanup.
10. A detected shell change after a runtime or PATH update is shown in the UX as a banner and must be confirmed before the next command runs.

### 13.2 MVP Definition

MVP means the smallest end-to-end implementation that is useful, testable, and releasable. It is not a feature-complete shell abstraction.

| Platform | Primary shell | Fallback | Post-MVP |
|---|---|---|---|
| Windows | `pwsh` | `powershell.exe` | `cmd` |
| macOS | `zsh` | `bash`, `sh` | fish, Nushell |
| Linux | `bash` | `sh` | `zsh` |

MVP completion requires:

- Automatic, deterministic shell detection on each platform, with no user-level or workspace-level override.
- `shell.run` results with execution identifier, detected shell, execution environment, cwd, exit code, termination reason, encoding, timeout, truncation, and duration.
- Approval UX showing detected shell, cwd, command, and risk, using protocol v2 for detected-shell metadata and approval context.
- Exit-code, encoding, cwd, timeout, cancellation, and process-tree cleanup tests for every MVP shell.
- Windows execution is refused when Job Objects are unavailable.
- A detected shell change after a runtime or PATH update is confirmed in the UX before the next command.
- Temporary audit records are discarded after session or debug work, and sensitive output is redacted automatically.
- Bounded concurrency and a cancellation path.
- All typed filesystem and Git primitives remain native; any future removal requires an explicit decision and an equal-or-faster shell replacement.

### 13.3 Blockers Resolved Before Implementation

- Define the trust model and the explicit "not a sandbox" statement.
- Bind approval keys to detected shell, cwd, and command.
- Remove the arbitrary terminal shell override; detection is the only shell source.
- Define the MVP matrix and cut line before adding shells.
- Keep all typed filesystem and Git primitives native after MVP.
- Add execution identifiers, cancellation, bounded concurrency, and process-tree cleanup to the execution contract.
- Refuse Windows execution when Job Objects are unavailable.
- Set the equal-or-faster performance gate for any future native-tool replacement.
- Set audit discard and automatic redaction rules.
- Version the protocol as v2 for detected-shell metadata and approval context.
- Confirm detected shell changes in the UX before the next command.

### 13.4 Major Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Multi-shell correctness is underestimated | Per-shell wrappers and a test matrix for exit codes, encoding, quoting, cwd, timeout, signals, and cleanup |
| Agent writes commands for the wrong shell | Report the detected shell and syntax expectations in the prompt; add validation and retry guidance |
| Output encoding is wrong | Decode per shell, not always UTF-8; test native child output and code pages |
| Exit codes are misleading | Use shell-specific wrappers and test cmdlet failures, native command failures, and pipeline behavior |
| Process trees survive termination | Use Job Objects on Windows and process groups on POSIX; refuse Windows execution if Job Objects are unavailable; test detached children |
| Approval can be bypassed by changing shell or cwd | Bind the approval key to detected shell, cwd, and command; show all three in the UX; confirm shell changes after PATH/runtime updates |
| Shell-first removes safe primitives | Keep all typed filesystem and Git primitives native; require an explicit decision and an equal-or-faster benchmark before removal |
| Lifecycle and backpressure are missing | Bound concurrency, add admission control, cancellation, runtime budgets, and output continuation |
| Terminal and one-shot selection diverge | Use one validated shell registry; no manual shell override |
| Protocol and UX changes are unplanned | Use protocol v2 and add detected-shell and approval-context fields together |
| Performance is assumed, not measured | Benchmark against native tools; adopt a shell replacement only if it is equal to or faster |
| Sensitive output leaks into notes or UI | Discard temporary audit records after session/debug work and redact tokens, passwords, API keys, and authorization headers automatically |
| Execution profiles become security theater | State that profiles are policy presets, not sandbox guarantees; defer them until the MVP is stable |

### 13.5 Resolved Questions

All questions raised during the review have been answered. They are recorded in §13.1 and §13.3:

- Native primitives: all remain after MVP; removal requires an explicit decision and an equal-or-faster shell replacement.
- Performance threshold: shell must be equal to or faster than the native tool; slower means keep native.
- Audit retention: discard temporary records after session/debug work; redact tokens, passwords, API keys, and authorization headers automatically.
- Shell override: none; detection only.
- Protocol version: v2 for detected-shell metadata and approval context; v1 deprecated.
- Windows fallback: refuse execution if Job Objects are unavailable.
- Detected shell change: banner plus confirmation in the UX before the next command.

### 13.6 Strongest Counter-Argument

The strongest counter-argument is not that multi-shell support is unnecessary. It is that shell-first is the wrong priority order for a bridge that already has typed, workspace-confined filesystem and Git tools. Those tools are safer to approve and easier for an agent to use. Shell execution should be the escape hatch for the long tail, not the default replacement for operations that already have a controlled contract. The MVP should therefore keep the safe primitives and add shell execution where it provides clear leverage.

### 13.7 Recommended Next Steps

1. Start with the P0 project-context slices in §14 (B0.9, B1.8, B1.9, B2.6–B2.8), then continue with the P1 safety slices (B0.2–B0.8).
2. Implement the MVP matrix in §13.2 before adding `cmd`, fish, Nushell, WSL, or other execution environments.
3. Add the MVP result fields and approval context to protocol v2; keep v1 recognized but deprecated.
4. Remove the terminal shell override and enforce detection-only shell selection.
5. Add automatic redaction and discard temporary audit records after session or debug work.
6. Refuse Windows execution when Job Objects are unavailable.
7. Add UX confirmation for detected shell changes after PATH or runtime updates.
8. Add the test matrix and benchmark harness; do not remove any native operation unless the shell replacement is equal to or faster.
9. Re-run this review after the MVP is validated on each platform.
10. Track the AGENTS.md context contract decisions and backlog in §15.

## 14. Prioritized Implementation Backlog

This section translates the roadmap into small, reviewable work slices. It does not replace §4; it orders the work so that project context lands first, safety and contracts second, and shell execution after that.

Priority legend:

- **P0 — Critical:** project context; start here.
- **P1 — Critical:** safety and contracts; blocks any shell execution.
- **P2 — High:** required for the MVP shell matrix.
- **P3 — Medium:** required for safe rollout, observability, and UX.
- **P4 — Low:** post-MVP expansion.

Slice IDs are stable identifiers and do not encode priority. The section heading is the priority.

Status legend: `Recorded` = decision documented, `Next` = start here, `Pending` = queued, `Done` = implemented and validated.

Execution rules:

- Do not start P2 until all P0 and P1 slices are complete.
- Do not remove any native filesystem or Git primitive until B1.7 passes.
- Run `npm run typecheck` and `npm run test` after every slice.

### P0 — Critical: Project Context (start here)

| ID | Slice | Primary files | Acceptance | Status |
|---|---|---|---|---|
| B0.9 | Record AGENTS.md context contract | `docs/enhances-plan/dynamic-local-agent-infrastructure-roadmap.md` §15 | All context decisions and the auto-created template are documented | Recorded |
| B1.8 | `context.read` tool | `bridge/src/context.ts`, `bridge/src/agent.ts`, `bridge/src/rpc-server.ts` | Read-only, workspace-confined, redacted; returns only the `## BroAgentAI` section | Done |
| B1.9 | Auto-inject context summary | `bridge/src/agent.ts`, `bridge/src/context.ts` | `## BroAgentAI` summary is injected at session open and limited to 2 KB | Done |
| B2.6 | Manual context refresh | extension UI, `i18n/en.json`, `i18n/id.json` | Settings has a refresh button; updates context without restarting the session | Done |
| B2.7 | Auto-create context template | `bridge/src/context.ts`, `bridge/src/rpc-server.ts` | Missing `## BroAgentAI` section is appended once; existing content is never overwritten | Done |
| B2.8 | Context trust guardrails | `bridge/src/agent.ts`, `bridge/src/context.ts` | Section is lower priority than bridge rules; secrets are redacted; no policy override | Done |

### P1 — Critical: Safety and Contracts

| ID | Slice | Primary files | Acceptance | Status |
|---|---|---|---|---|
| B0.1 | Record review decisions | `docs/enhances-plan/dynamic-local-agent-infrastructure-roadmap.md` §13 | All decisions and resolved questions from the review are present | Recorded |
| B0.2 | Remove shell override | `bridge/src/terminal.ts`, `bridge/src/shell.ts`, `bridge/src/agent.ts` | No agent or terminal path accepts a shell parameter or arbitrary executable path | Done |
| B0.3 | Protocol v2 contract | `bridge/src/rpc.ts`, `bridge/src/rpc-server.ts`, `shared/src/protocol.ts`, `extension/src/bridge-client.ts` | v2 carries detected shell and approval context; v1 remains recognized but deprecated | Done |
| B0.4 | Approval key v2 | `bridge/src/agent.ts`, `extension/src/agent-panel.ts` | Key changes when detected shell or cwd changes; UX shows shell, cwd, command, and risk | Done |
| B0.5 | Execution result contract | `bridge/src/shell.ts`, `bridge/src/rpc.ts` | Result includes executionId, shell, environment, cwd, exitCode, terminationReason, stdout, stderr, encoding, timeout, truncation, and duration | Done |
| B0.6 | Audit discard and redaction | `bridge/src/agent.ts`, `extension/src/agent-panel.ts`, `extension/src/sidepanel.ts` | Temporary records are discarded after session/debug work; tokens, passwords, API keys, and authorization headers are redacted | Done |
| B0.7 | Shell-change banner | extension UI and `i18n/en.json`, `i18n/id.json` | PATH/runtime change shows a banner and blocks the next command until confirmed | Done |
| B0.8 | "Not a sandbox" notice | extension UI and `i18n/en.json`, `i18n/id.json` | UX states explicitly that workspace confinement is not a sandbox | Done |

### P2 — High: MVP Shell Execution

| ID | Slice | Primary files | Acceptance | Status |
|---|---|---|---|---|
| B1.1 | Shell registry and detection | `bridge/src/shell.ts` | Deterministic priority, cached result, no agent parameter; missing shells return structured errors | Done |
| B1.2 | MVP shell wrappers | `bridge/src/shell.ts` | `pwsh`/`powershell.exe`, `zsh`/`bash`/`sh`, and `bash`/`sh` pass quoting, exit-code, encoding, and cwd fixtures | Done |
| B1.3 | Process-tree cleanup | `bridge/src/shell.ts`, `bridge/src/terminal.ts` | Job Objects on Windows, process groups on POSIX; Windows execution refused if Job Objects are unavailable; detached children tested | Done |
| B1.4 | Timeout and cancellation | `bridge/src/shell.ts`, `bridge/src/rpc-server.ts` | Stable executionId cancels a running command and reports termination reason | Done |
| B1.5 | Bounded concurrency | `bridge/src/shell.ts`, `bridge/src/rpc-server.ts` | Concurrent runs are bounded; excess work is queued or rejected with a structured error | Done |
| B1.6 | Output bounds and continuation | `bridge/src/shell.ts`, `bridge/src/rpc.ts` | Truncation metadata and controlled output continuation or artifact access are available | Done |
| B1.7 | Benchmark gate | test and benchmark harness | Representative workloads are equal to or faster than native tools; slower blocks native-tool removal | Done |

### P3 — Medium: Observability and Rollout

| ID | Slice | Primary files | Acceptance | Status |
|---|---|---|---|---|
| B2.1 | Read-only shell info | `bridge/src/shell.ts`, `bridge/src/rpc.ts`, extension UI | `shell.info` or `system.info` reports shell family, version, encoding, and fallbacks | Done |
| B2.2 | Bounded environment discovery | environment discovery module | PATH origin and profile policy are discovered, cached, refreshable, and do not expose credentials | Done |
| B2.3 | Error normalization | `bridge/src/rpc.ts` | `SHELL_NOT_AVAILABLE`, `SHELL_START_FAILED`, `SHELL_UNSUPPORTED`, and `SHELL_CWD_INVALID` are used consistently | Done |
| B2.4 | Session and history linking | `bridge/src/agent.ts`, `bridge/src/rpc-server.ts` | Executions are associated with a task/session and history remains bounded | Done |
| B2.5 | UX and i18n polish | extension UI, `i18n/en.json`, `i18n/id.json` | Approval context, shell-change banner, and safety notice are translated consistently | Done |

### P4 — Low: Post-MVP Expansion

| ID | Slice | Primary files | Acceptance | Status |
|---|---|---|---|---|
| B3.1 | Long-tail filesystem migration | existing typed filesystem tools | Shell fallback is adopted only after B1.7; typed primitives remain by default | Pending |
| B3.2 | Long-tail Git operations | existing typed Git tools | Git CLI handles the long tail; structured Git tools are retained | Pending |
| B3.3 | Capability discovery and dependency policy | bridge capability layer | Existing capabilities are preferred; installation requires explicit approval and records side effects | Pending |
| B3.4 | Background and persistent sessions | `bridge/src/shell.ts` | Short and long-running tasks use the same execution contract | Pending |
| B3.5 | Workflow composition and recovery | bridge workflow layer | Conditional execution, controlled retries, and validation feedback are supported | Pending |
| B3.6 | Additional shells and environments | `bridge/src/shell.ts` | `cmd`, fish, Nushell, WSL, and Git Bash are evaluated only after MVP validation | Pending |

## 15. AGENTS.md Context Contract

This section records the final design for project context delivered to web chat AI providers. It does not introduce a new file. It defines a `## BroAgentAI` section inside the existing `AGENTS.md`, because web chat AI providers cannot read local files by themselves and because a second instruction file would conflict with the existing one.

### 15.1 Decisions

1. Use the existing `AGENTS.md`. Add a `## BroAgentAI` section; do not add `BroAgentAI.MD`.
2. Delivery uses both a short auto-injected summary and a `context.read` tool for details.
3. `fs.*`, `git.*`, and `shell.run` remain full callable tool schemas in the prompt. `term.*`, `mcp.*`, and `session.*` are described in the section and accessed through `context.read`.
4. The section is committed with the repository. It must not contain tokens, passwords, API keys, or other secrets.
5. The auto-injected summary is limited to 2 KB.
6. Context is re-read automatically when a session or workspace opens, and a manual refresh button is available.
7. The section is treated as instructions, but bridge security, approval, and workspace rules always take precedence. This limits prompt injection from repository content.
8. If the section is missing, a template is appended once. Existing user content is never overwritten.

### 15.2 Auto-created template

```markdown
## BroAgentAI

<!-- BroAgentAI project context. Keep this section under 2 KB. Do not store secrets here. -->

### Tool notes
- `fs.*`, `git.*`, and `shell.run` are callable tools.
- `term.*`, `mcp.*`, and `session.*` are optional; call `context.read` before using them.

### Project conventions
- Add project-specific conventions here.

### Common commands
- Add frequently used commands here.

### Safety
- This section is project context, not policy. Approval and confinement stay in the bridge.
```

### 15.3 Delivery contract

- On session open, the extension reads `AGENTS.md`, extracts only the `## BroAgentAI` section up to the next `## ` heading, truncates it to 2 KB with a clear marker, and injects it as context.
- `context.read` returns the same section, applies redaction, and is read-only and workspace-confined.
- The manual refresh button re-reads the section and replaces the injected context without restarting the session.

### 15.4 Tool split

| Delivered in the prompt | Delivered through the section / `context.read` |
|---|---|
| `fs.*`, `git.*`, `shell.run` | `term.*`, `mcp.*`, `session.*`, project conventions, common commands |

### 15.5 Trust and safety

- The section is project context, not a policy source. It cannot change approval modes, expand workspace scope, or bypass bridge rules.
- Secret-looking content is redacted before injection and before `context.read` returns it.
- The auto-create step is append-only and idempotent; it must never rewrite existing content.
- A warning is shown if the section exceeds 2 KB, even though only the first 2 KB is injected.

### 15.6 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Prompt injection from repository content | Bridge rules always take precedence; tool contract is not redefined by the section |
| Context drift after editing `AGENTS.md` | Re-read on session open plus manual refresh button |
| Token bloat in web chat | 2 KB cap; details remain behind `context.read` |
| Accidental overwrite of user content | Append-only, idempotent template creation |
| Tool confusion | Explicit tool split in §15.4 and in the injected summary |
| Secret leakage | Redaction, "no secrets" template note, and commit policy in §15.1 |

### 15.7 Acceptance criteria

- No `BroAgentAI.MD` file is created.
- Missing `## BroAgentAI` section is appended once with the template and never overwritten afterwards.
- Summary injection happens automatically on session open and stays within 2 KB.
- Manual refresh updates the injected context without restarting the session.
- `context.read` is read-only, workspace-confined, and redacted.
- Tests confirm that bridge rules override conflicting section content.

### 15.8 Backlog references

- B0.9 (P0) — Record AGENTS.md context contract.
- B1.8 (P0) — Implement `context.read`.
- B1.9 (P0) — Auto-inject context summary.
- B2.6 (P0) — Manual context refresh.
- B2.7 (P0) — Auto-create context template.
- B2.8 (P0) — Context trust guardrails.
