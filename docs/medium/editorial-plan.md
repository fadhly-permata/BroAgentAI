# BroAgentAI — Medium Editorial Plan

**Publication:** Medium  
**Project:** BroAgentAI  
**Editorial approach:** Build in public, practical technology storytelling, and accessible explanations of AI agents.  
**Primary audience:** Developers, AI enthusiasts, software builders, technology-curious readers, and people interested in practical AI automation.  
**Article language:** English (natural, accessible, international readership).  
**Status:** Draft editorial roadmap — pending review.

## Editorial positioning

BroAgentAI explores a practical question: what if the AI chat people already use could do useful work inside their local development projects?

Rather than presenting the project as another chatbot or a replacement for every coding tool, the articles will explain the ideas behind connecting browser-based AI chats to local tools, keeping users in control, and building useful automation with clear boundaries.

The project is currently at an early v0.1 stage. Articles must distinguish implemented capabilities from future possibilities, avoid unsupported performance claims, and describe limitations honestly.

## The 10-article series

### 01 — Beyond Chatbots: What Happens When AI Can Actually Do Things?
- **Angle:** An accessible introduction to the shift from conversational AI to AI agents that can interact with tools and complete practical tasks.
- **Reader takeaway:** Understand the difference between an AI that gives instructions and an AI workflow that can act on a project with permission.
- **BroAgentAI connection:** Introduce the idea of using an existing browser-based AI chat to work with local project files and development tools.
- **Status:** First draft to be reviewed.

### 02 — Your AI Is Smart. So Why Can't It Open Your Project?
- **Angle:** Explain the gap between AI's ability to reason about code and its lack of direct access to a developer's local workspace.
- **Reader takeaway:** Understand why copy-paste workflows happen and why a controlled connection to local tools matters.
- **BroAgentAI connection:** Explain the motivation for connecting browser chats to a local bridge.

### 03 — The Local-First AI Agent: Keeping Your Work on Your Machine
- **Angle:** Explain local-first architecture in plain language and compare it with workflows that depend on cloud services.
- **Reader takeaway:** Learn what local execution can protect, what it cannot protect, and why information deliberately shared with an AI service still leaves the machine.
- **BroAgentAI connection:** Native Messaging, local bridge, workspace boundaries, and the absence of a BroAgentAI cloud backend.

### 04 — Giving AI Tools Without Giving It the Keys to Everything
- **Angle:** Explore the principle of least privilege and why tool access should be limited and understandable.
- **Reader takeaway:** Understand workspace restrictions, approval modes, and the difference between reading and changing files.
- **BroAgentAI connection:** Read-only, Always Ask, Ask Once, Auto Approve, and workspace path restrictions.

### 05 — The Approval Button Is a Feature, Not an Obstacle
- **Angle:** Explain human-in-the-loop automation and why review before consequential actions is valuable.
- **Reader takeaway:** Learn how approval gates, diffs, and activity logs make automation more accountable.
- **BroAgentAI connection:** Tool activity log, write diff previews, and Allow/Deny workflow.

### 06 — How AI Agents Use Tools: A Practical Guide to MCP
- **Angle:** Introduce the Model Context Protocol (MCP) as a way to connect AI workflows with external tools, without assuming prior knowledge.
- **Reader takeaway:** Understand the role of tool catalogs, local and remote servers, and risk-aware access.
- **BroAgentAI connection:** MCP server configuration, trust review, and read/write/destructive risk categories.

### 07 — From Browser Chat to Coding Workspace: Rethinking the Developer Workflow
- **Angle:** Explore how familiar browser-based AI chats can become part of a practical development workflow.
- **Reader takeaway:** See how file exploration, search, editing, terminal work, and Git operations fit together.
- **BroAgentAI connection:** Side panel, explorer, editor, terminal, and source control.

### 08 — Why AI Automation Needs Tests, Logs, and Honest Failure Reports
- **Angle:** Explain reliability as an engineering problem rather than assuming an AI agent will always do the right thing.
- **Reader takeaway:** Learn why test coverage, observable actions, clear errors, and reproducible workflows matter.
- **BroAgentAI connection:** Type checking, unit tests, end-to-end tests, activity logs, and known early-stage limitations.

### 09 — One AI Chat Is Not Always Enough: Designing Workflows Across Providers
- **Angle:** Discuss the opportunities and challenges of supporting multiple AI chat providers through a consistent tool workflow.
- **Reader takeaway:** Understand provider adapters, changing web interfaces, portability, and the limits of UI-based integrations.
- **BroAgentAI connection:** Provider plugins, supported chats, experimental integrations, and session switching.

### 10 — Building in Public: Lessons From Creating a Browser-Based Local AI Agent
- **Angle:** A reflective build-in-public article about the engineering decisions, trade-offs, rough edges, and lessons learned.
- **Reader takeaway:** See how a real software project evolves through iteration rather than appearing fully formed.
- **BroAgentAI connection:** Project architecture, development workflow, testing, current status, and next challenges.

## Editorial and accuracy rules

1. Use accessible English. Explain technical terms the first time they appear.
2. Prefer concrete examples and analogies over unexplained jargon.
3. Keep each article focused on one central idea; avoid turning every article into a product feature list.
4. Present BroAgentAI as a case study and practical example, not as an advertisement.
5. Never claim a feature is complete unless the current implementation or project documentation supports that claim.
6. Clearly label experimental integrations and early-stage limitations.
7. Explain security boundaries accurately. Local-first does not mean that content sent to a third-party AI chat stays local.
8. Do not imply that approval modes eliminate all risk. Auto Approve explicitly permits actions without per-action confirmation.
9. Avoid fabricated benchmarks, user numbers, testimonials, provider endorsements, or claims of universal compatibility.
10. Use original diagrams or project screenshots only when they clarify the article and are appropriate for public release.
11. Do not publish credentials, private configuration, personal data, internal paths, or sensitive project details.
12. End with a useful takeaway and a restrained project reference or invitation to explore the repository.

## Standard article package

Each article should include:
- Working title and subtitle
- A clear opening hook
- Main sections with descriptive headings
- Practical examples or analogies
- A balanced discussion of trade-offs and limitations
- A concise conclusion
- Suggested Medium tags (up to five)
- Optional visual concept and caption
- Source notes for project-specific claims
- Review status and revision date

## Review workflow

- `Draft`: Initial article has been written.
- `In Review`: Ready for the project owner's review.
- `Needs Revision`: Changes requested.
- `Approved`: Owner has approved the content for publication.
- `Published`: Publication URL and date have been recorded.

**Current publication policy:** Draft locally first. Nothing is published to Medium automatically without an explicit publication decision and the required account authorization.

## Suggested cadence

One article per week is a sustainable starting point. The sequence can be adjusted as the project evolves. Technical claims should be checked against the implementation and README again before publication, especially when an article discusses features that may change.
