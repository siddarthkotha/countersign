# LinkedIn Skills Repos Check — 2026-09-02

## 1. Anthropic Skills
**URL:** https://github.com/anthropics/skills
**What:** Official Anthropic collection of Agent Skills—folder-based examples teaching Claude how to complete specialized tasks (documents, data analysis, workflows).
**For:** Developers building custom skills and integrations.
**Install:** `/plugin marketplace add anthropics/skills` (Claude Code) or upload to Claude.ai.

## 2. Superpowers
**URL:** https://github.com/obra/superpowers
**What:** Complete software development methodology for coding agents—guides AI through design, testing, and code review stages rather than jumping to coding.
**For:** Developers who use AI coding agents (Claude Code, Cursor, Copilot).
**Install:** `/plugin install superpowers@claude-plugins-official` (agent-specific syntax varies).

## 3. Karpathy Skills
**URL:** https://github.com/multica-ai/andrej-karpathy-skills
**What:** Coding guidelines based on Andrej Karpathy's principles (think before coding, simplicity first, surgical changes, goal-driven execution).
**For:** Software developers using Claude Code or Cursor.
**Install:** `curl -o CLAUDE.md https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/CLAUDE.md` or `/plugin install andrej-karpathy-skills@karpathy-skills`.

## 4. Skills for Real Engineers (Matt Pocock)
**URL:** https://github.com/mattpocock/skills
**What:** ~20 reusable AI agent skills addressing real engineering problems (miscommunication, verbose outputs, buggy code, poor architecture).
**For:** Software developers and engineers building production applications.
**Install:** `npx skills@latest add mattpocock/skills` or `claude plugins install mattpocock-skills`.

## 5. UI/UX Pro Max Skill
**URL:** https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
**What:** AI-powered design intelligence skill generating professional UI/UX with design systems, color schemes, typography, and layout patterns (192 reasoning rules, 79 UI styles, 22 tech stacks).
**For:** Developers using AI code assistants (Claude Code, Cursor, Windsurf).
**Install:** `npm install -g ui-ux-pro-max-cli && uipro init --ai claude`.

## 6. Caveman
**URL:** https://github.com/JuliusBrussee/caveman
**What:** Claude Code skill reducing token usage by ~65% on output and ~33% on input through terse communication (includes proxy tool and token analysis).
**For:** Developers using AI agents who want to lower API costs.
**Install:** `npx skills add JuliusBrussee/caveman`.

## 7. Addy Osmani's Agent Skills
**URL:** https://github.com/addyosmani/agent-skills
**What:** 25 structured workflows for complete software development lifecycle—enforces production-grade practices (specs, TDD, security review, staged rollout).
**For:** Developers and engineering teams using AI coding agents.
**Install:** `npx skills add addyosmani/agent-skills`.

## 8. Taste Skill
**URL:** https://github.com/Leonxlnx/taste-skill
**What:** Collection of portable agent skills improving visual quality of AI-generated interfaces—rules for layout, typography, motion, spacing (minimalist, brutalist, soft luxury styles).
**For:** Developers using AI coding assistants who want elevated design quality.
**Install:** `npx skills add https://github.com/Leonxlnx/taste-skill`.

## 9. Awesome Claude Skills
**URL:** https://github.com/ComposioHQ/awesome-claude-skills
**What:** Curated collection of 1,000+ production-ready Claude Skills—reusable instruction packages for document processing, coding, data analysis, business automation, 78+ SaaS integrations.
**For:** Developers building AI agents and automating workflows.
**Install:** Place skill folder in `~/.config/claude-code/skills/` and restart Claude Code.

## 10. I Have ADHD Skill
**URL:** https://github.com/ayghri/i-have-adhd
**What:** Plugin reformatting AI responses to be concise and action-oriented—direct commands, numbered steps, clear next actions instead of verbose explanations.
**For:** Developers using AI coding assistants who prefer direct guidance.
**Install:** Refer to repo's AGENTS.md or INSTALL.md for platform-specific steps.

---
**Summary:** All 10 resolved. Nine are Claude Code/coding-agent skills (for developers). One (Awesome Claude Skills) is a curated directory/meta-collection. Installation patterns: mostly `npx skills add` or CLI-specific plugin managers; Anthropic uses `/plugin marketplace`; Awesome Claude Skills uses filesystem placement.
