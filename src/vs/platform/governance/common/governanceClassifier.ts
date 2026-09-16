/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GovernanceRiskTier, GovernedActionKind, IGovernedAction, RISK_TIER_ORDER } from './governance.js';

function isRiskierThan(tier: GovernanceRiskTier, other: GovernanceRiskTier): boolean {
	return RISK_TIER_ORDER.indexOf(tier) > RISK_TIER_ORDER.indexOf(other);
}

function maxTier(tiers: readonly GovernanceRiskTier[]): GovernanceRiskTier {
	return tiers.reduce(
		(highest, tier) => (isRiskierThan(tier, highest) ? tier : highest),
		GovernanceRiskTier.Read
	);
}

//#region Command lines

/**
 * Kubernetes contexts that denote a cluster running on the developer's own
 * machine. Everything else is treated as shared infrastructure.
 *
 * This list is the entire basis for the "local Docker is low-friction, remote
 * clusters are not" rule, so it is deliberately an allowlist: an unrecognised
 * context escalates rather than being waved through.
 */
const LOCAL_KUBE_CONTEXTS = [
	/^minikube$/,
	/^kind-/,
	/^k3d-/,
	/^docker-desktop$/,
	/^docker-for-desktop$/,
	/^rancher-desktop$/,
	/^colima$/,
	/^orbstack$/,
];

/** Docker contexts that talk to a daemon on the developer's own machine. */
const LOCAL_DOCKER_CONTEXTS = new Set(['default', 'desktop-linux', 'colima', 'orbstack', 'rancher-desktop']);

/** Branch names whose history is shared, so pushing to them is production-impacting. */
const PROTECTED_BRANCHES = [/^main$/, /^master$/, /^release\//, /^prod/];

/**
 * Executables that run another command given later on their command line
 * (`sudo`, `env`, `bash -c`, `npx`, ...). Every later token of such a segment
 * is classified as a possible executable, because working out which one really
 * is would need a parser for each wrapper's options. That can only add tiers,
 * never hide one.
 */
const WRAPPERS = new Set([
	'sudo', 'doas', 'gsudo', 'runas', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice',
	'timeout', 'xargs', 'watch', 'stdbuf', 'caffeinate', 'npx', 'pnpx', 'bunx', 'uvx',
	'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'eval', 'wsl', 'call', 'start', 'iex', 'invoke-expression',
]);

/** How many recognised programs one wrapper segment may name before classification gives up and fails closed. */
const MAX_WRAPPED_COMMANDS = 64;

/** Wrappers that run their command as another (usually more privileged) user. */
const ELEVATING = new Set(['sudo', 'doas', 'gsudo', 'runas']);

/** Local Kubernetes cluster managers: container lifecycle on the developer's own machine. */
const LOCAL_CLUSTER_TOOLS = new Set(['minikube', 'kind', 'k3d']);

/**
 * CLIs that address remote, shared services by definition: cloud providers,
 * hosting and deployment platforms, code hosts and configuration management.
 */
const REMOTE_CLIS = new Set([
	'aws', 'gcloud', 'gsutil', 'bq', 'az', 'oci', 'ibmcloud', 'hcloud', 'doctl', 'eksctl',
	'fly', 'flyctl', 'heroku', 'vercel', 'netlify', 'firebase', 'wrangler', 'railway',
	'serverless', 'sls', 'sam', 'cdk', 'eb', 'argocd', 'flux', 'kubectx', 'kubens',
	'ansible', 'ansible-playbook', 'gh', 'glab',
]);

/** Positional arguments that make a remote CLI call a deploy, release, merge or deletion. */
const PRODUCTION_VERBS = new Set(['deploy', 'publish', 'release', 'promote', 'rollback', 'destroy', 'delete', 'merge']);

/** Package managers and build tools whose publishing commands release an artifact to a public or shared registry. */
const PACKAGE_TOOLS = new Set([
	'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'poetry', 'uv', 'twine', 'gem', 'dotnet', 'nuget', 'mvn', 'gradle', 'gradlew', 'vsce', 'ovsx',
]);

/** Subcommands of {@link PACKAGE_TOOLS} that publish, or change what is already published. */
const PUBLISH_VERBS = new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'upload', 'push']);

/** Task runners, whose targets are opaque here: `make deploy` is judged by its target's name. */
const TASK_RUNNERS = new Set(['make', 'just', 'task', 'gulp', 'grunt', 'rake', 'invoke', 'mage', 'nx', 'turbo']);

/** Target names that suggest a task runner (or a package script) deploys or releases. */
const DEPLOY_TARGETS = new Set(['deploy', 'release', 'publish', 'promote', 'rollback']);

/** Database clients, which change shared data when pointed at a remote server. */
const DATABASE_CLIENTS = new Set(['psql', 'pg_restore', 'mysql', 'mariadb', 'mongosh', 'mongo', 'redis-cli', 'sqlcmd']);

const ENV_ASSIGNMENT = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/;

function isLocalKubeContext(context: string): boolean {
	return LOCAL_KUBE_CONTEXTS.some(pattern => pattern.test(context));
}

/** True for hosts on the developer's own machine. An empty host means the client's local default. */
function isLocalHost(host: string): boolean {
	const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
	return normalized === ''
		|| normalized === 'localhost'
		|| normalized.endsWith('.localhost')
		|| normalized === '::1'
		|| normalized === '0.0.0.0'
		|| normalized === 'host.docker.internal'
		|| /^127\./.test(normalized)
		// A Unix socket path.
		|| normalized.startsWith('/');
}

/** Reads the value of `--flag value` or `--flag=value` from an argument list. */
function readFlag(args: readonly string[], ...names: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		for (const name of names) {
			if (arg === name) {
				return args[i + 1];
			}
			if (arg.startsWith(`${name}=`)) {
				return arg.slice(name.length + 1);
			}
		}
	}
	return undefined;
}

/**
 * Arguments that don't look like flags. Naive: the value of `--flag value`
 * counts as positional. Callers only test positionals for risky words, so the
 * extra entries can raise a tier but not lower one.
 */
function positionals(args: readonly string[]): string[] {
	return args.filter(arg => !arg.startsWith('-'));
}

/**
 * Splits a command line on shell separators so that `cd foo && kubectl apply`
 * is classified by its riskiest part rather than by `cd`. Newlines, background
 * `&`, subshells, command substitution and brace groups separate commands too.
 *
 * This is not a shell parser. It does not understand quoting, so a separator
 * inside a quoted string splits a segment that should have stayed whole. That
 * direction is safe: it produces more segments to classify, never fewer.
 */
function splitSegments(commandLine: string): string[] {
	return commandLine
		.split(/&&|\|\||\$\(|[;|&\r\n()`{}]/)
		.map(segment => segment.trim())
		.filter(segment => segment.length > 0);
}

/** Splits on whitespace and drops quote characters, so `--context "prod"` reads as `--context prod`. */
function tokenize(segment: string): string[] {
	return segment
		.split(/\s+/)
		.map(token => token.replace(/["']/g, ''))
		.filter(token => token.length > 0);
}

/** `/usr/local/bin/kubectl` → `kubectl`, `C:\tools\KUBECTL.EXE` → `kubectl`. */
function executableName(token: string): string {
	const base = token.split(/[\\/]/).pop() ?? token;
	return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** Hosts named by host flags, `host=` connection strings and URLs among `args`. */
function databaseHosts(args: readonly string[], env: ReadonlyMap<string, string>): string[] {
	const hosts: string[] = [];
	const flagged = readFlag(args, '-h', '--host', '-S', '--server');
	if (flagged !== undefined) {
		hosts.push(flagged);
	}
	for (const name of ['PGHOST', 'MYSQL_HOST']) {
		const value = env.get(name);
		if (value !== undefined) {
			hosts.push(value);
		}
	}
	for (const arg of args) {
		const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(?<host>\[[^\]]*\]|[^:/?#,]*)/i.exec(arg);
		if (url?.groups) {
			// `mongodb+srv://` always resolves through DNS to a remote cluster.
			hosts.push(arg.toLowerCase().startsWith('mongodb+srv:') ? 'srv' : url.groups.host);
		}
		const keyword = /^host=(?<host>.*)$/.exec(arg);
		if (keyword?.groups) {
			hosts.push(keyword.groups.host);
		}
	}
	return hosts;
}

function classifyKubernetes(args: readonly string[]): GovernanceRiskTier {
	const context = readFlag(args, '--context', '--kube-context');
	// No explicit context means the ambient kubeconfig decides, which we cannot
	// see from here. Assume shared infrastructure.
	if (context === undefined || !isLocalKubeContext(context)) {
		return GovernanceRiskTier.RemoteInfra;
	}
	return GovernanceRiskTier.LocalInfra;
}

/** Client options of docker, podman and docker-compose that take a separate value, which come before the subcommand. */
const DOCKER_GLOBAL_OPTIONS_WITH_VALUE = new Set(['-H', '--host', '--url', '-c', '--context', '--connection', '--config', '-l', '--log-level', '-f', '--file', '-p', '--project-name']);

function classifyDocker(args: readonly string[], env: ReadonlyMap<string, string>): GovernanceRiskTier {
	// Only the client's own options, before the subcommand, say where it connects:
	// the same letters later on belong to the container (`docker run img sh -c ...`).
	let index = 0;
	while (index < args.length && args[index].startsWith('-')) {
		index += DOCKER_GLOBAL_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
	}
	const clientArgs = args.slice(0, index);

	// A docker client can be pointed at a remote daemon, at which point it is
	// no longer a local-only action.
	const hosts = [readFlag(clientArgs, '-H', '--host', '--url'), env.get('DOCKER_HOST'), env.get('CONTAINER_HOST')];
	if (hosts.some(host => host !== undefined && !/^(unix:|npipe:|fd:|$)/.test(host))) {
		return GovernanceRiskTier.RemoteInfra;
	}
	const context = readFlag(clientArgs, '--context', '-c', '--connection') ?? env.get('DOCKER_CONTEXT');
	if (context !== undefined && !LOCAL_DOCKER_CONTEXTS.has(context)) {
		return GovernanceRiskTier.RemoteInfra;
	}
	const positional = positionals(args);
	// `docker context use prod` points every later command at a remote daemon.
	if (positional[0] === 'context' && positional[1] === 'use' && positional[2] !== undefined && !LOCAL_DOCKER_CONTEXTS.has(positional[2])) {
		return GovernanceRiskTier.RemoteInfra;
	}
	// Pushing an image or logging in to a registry reaches shared infrastructure.
	if (clientArgs.includes('--remote') || args.includes('--push') || positional.includes('push') || positional.includes('login')) {
		return GovernanceRiskTier.RemoteInfra;
	}
	return GovernanceRiskTier.LocalInfra;
}

/** Git's own options that take a separate value, which come before the subcommand. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

function classifyGit(args: readonly string[]): GovernanceRiskTier {
	let index = 0;
	while (index < args.length && args[index].startsWith('-')) {
		index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
	}
	if (args[index] !== 'push') {
		return GovernanceRiskTier.LocalWrite;
	}
	const pushArgs = args.slice(index + 1);
	const forced = pushArgs.some(arg =>
		arg === '--force'
		|| arg === '--mirror'
		|| arg.startsWith('--force-with-lease')
		|| arg === '--force-if-includes'
		|| /^-[A-Za-z]*f[A-Za-z]*$/.test(arg)
		|| arg.startsWith('+'));
	if (forced) {
		return GovernanceRiskTier.Production;
	}
	const targetsProtectedBranch = positionals(pushArgs)
		.map(refspec => refspec.replace(/^.*:/, '').replace(/^refs\/heads\//, ''))
		.some(branch => PROTECTED_BRANCHES.some(pattern => pattern.test(branch)));
	return targetsProtectedBranch ? GovernanceRiskTier.Production : GovernanceRiskTier.RemoteInfra;
}

const IAC_PRODUCTION_SUBCOMMANDS = new Set(['apply', 'destroy', 'up', 'deploy', 'import', 'taint', 'untaint', 'force-unlock', 'refresh', 'cancel']);
const IAC_STATE_MUTATIONS = new Set(['rm', 'mv', 'push', 'delete', 'edit', 'move', 'replace-provider', 'unprotect']);

function classifyInfrastructureAsCode(args: readonly string[]): GovernanceRiskTier {
	// Any positional, not just the first: global options such as `-chdir=infra`
	// or `--cwd infra` come before the subcommand.
	const positional = positionals(args);
	if (positional.some(arg => IAC_PRODUCTION_SUBCOMMANDS.has(arg))) {
		return GovernanceRiskTier.Production;
	}
	if (positional.includes('state') && positional.some(arg => IAC_STATE_MUTATIONS.has(arg))) {
		return GovernanceRiskTier.Production;
	}
	// `plan` and `preview` still read remote state and can hold state locks.
	return GovernanceRiskTier.RemoteInfra;
}

function classifyRemoteCli(args: readonly string[]): GovernanceRiskTier {
	if (args.includes('--prod') || args.includes('--production') || positionals(args).some(arg => PRODUCTION_VERBS.has(arg))) {
		return GovernanceRiskTier.Production;
	}
	return GovernanceRiskTier.RemoteInfra;
}

function classifyPackageTool(args: readonly string[]): GovernanceRiskTier {
	const positional = positionals(args);
	if (positional.some(arg => PUBLISH_VERBS.has(arg))) {
		return GovernanceRiskTier.Production;
	}
	// `npm run deploy`: the script is opaque, but its name says where it goes.
	return positional.some(arg => DEPLOY_TARGETS.has(arg)) ? GovernanceRiskTier.RemoteInfra : GovernanceRiskTier.LocalWrite;
}

/**
 * @param args Read lazily: most executables are unknown and never need them,
 * which keeps a long wrapper segment from costing a copy per token.
 */
function classifyInvocation(executable: string, args: () => readonly string[], env: ReadonlyMap<string, string>): GovernanceRiskTier {
	switch (executable) {
		case 'kubectl':
		case 'oc':
		case 'helm':
		case 'kustomize':
		case 'skaffold':
		case 'tilt':
			return classifyKubernetes(args());
		case 'docker':
		case 'podman':
		case 'docker-compose':
		case 'nerdctl':
			return classifyDocker(args(), env);
		case 'git':
			return classifyGit(args());
		case 'terraform':
		case 'tofu':
		case 'terragrunt':
		case 'cdktf':
		case 'pulumi':
			return classifyInfrastructureAsCode(args());
		case 'ssh':
		case 'scp':
		case 'rsync':
		case 'sftp':
		case 'mosh':
			return GovernanceRiskTier.RemoteInfra;
	}
	if (LOCAL_CLUSTER_TOOLS.has(executable)) {
		return GovernanceRiskTier.LocalInfra;
	}
	if (REMOTE_CLIS.has(executable)) {
		return classifyRemoteCli(args());
	}
	if (PACKAGE_TOOLS.has(executable)) {
		return classifyPackageTool(args());
	}
	if (TASK_RUNNERS.has(executable)) {
		return positionals(args()).some(arg => DEPLOY_TARGETS.has(arg)) ? GovernanceRiskTier.RemoteInfra : GovernanceRiskTier.LocalWrite;
	}
	if (DATABASE_CLIENTS.has(executable)) {
		return databaseHosts(args(), env).every(isLocalHost) ? GovernanceRiskTier.LocalWrite : GovernanceRiskTier.RemoteInfra;
	}
	return GovernanceRiskTier.LocalWrite;
}

function classifySegment(segment: string): GovernanceRiskTier {
	const tokens = tokenize(segment);
	// Leading assignments (`DOCKER_HOST=tcp://prod docker ps`) change where the
	// command goes, so they are kept for the classifiers that read them.
	const env = new Map<string, string>();
	let start = 0;
	while (start < tokens.length) {
		const assignment = ENV_ASSIGNMENT.exec(tokens[start]);
		if (!assignment?.groups) {
			break;
		}
		env.set(assignment.groups.name, assignment.groups.value);
		start++;
	}
	if (start >= tokens.length) {
		return GovernanceRiskTier.Read;
	}

	const executable = executableName(tokens[start]);
	if (!WRAPPERS.has(executable)) {
		return classifyInvocation(executable, () => tokens.slice(start + 1), env);
	}

	// Running as root is not itself remote, but it escapes the workspace, so it
	// should never be quieter than a local infrastructure change.
	const tiers = [ELEVATING.has(executable) ? GovernanceRiskTier.LocalInfra : GovernanceRiskTier.LocalWrite];
	let argumentReads = 0;
	for (let i = start + 1; i < tokens.length; i++) {
		const assignment = ENV_ASSIGNMENT.exec(tokens[i]);
		if (assignment?.groups) {
			env.set(assignment.groups.name, assignment.groups.value);
			continue;
		}
		// A path is only a candidate when it looks like a program, so that
		// `npx prettier infra/terraform` isn't mistaken for running terraform.
		if (/[\\/]/.test(tokens[i]) && !/[\\/]\.?s?bin[\\/]|\.exe$/i.test(tokens[i])) {
			continue;
		}
		const candidate = executableName(tokens[i]);
		if (ELEVATING.has(candidate)) {
			tiers.push(GovernanceRiskTier.LocalInfra);
			continue;
		}
		// Each recognised program reads the rest of the segment, so a segment
		// packed with them would take quadratic time on the UI thread. Past a
		// budget no real command reaches, stop and fail closed.
		if (argumentReads >= MAX_WRAPPED_COMMANDS) {
			tiers.push(GovernanceRiskTier.Production);
			break;
		}
		tiers.push(classifyInvocation(candidate, () => {
			argumentReads++;
			return tokens.slice(i + 1);
		}, env));
	}
	return maxTier(tiers);
}

/**
 * Classifies a command line by its riskiest segment.
 *
 * An unrecognised executable is treated as {@link GovernanceRiskTier.LocalWrite}
 * rather than {@link GovernanceRiskTier.Read}: we cannot know that an unknown
 * binary has no side effects, and assuming it is inert is the one guess that
 * loses silently.
 *
 * What a command does indirectly — a script, a package script, a Makefile
 * target — is not visible here, apart from the name heuristics for deploy and
 * release targets.
 */
export function classifyCommandLine(commandLine: string): GovernanceRiskTier {
	const tiers = splitSegments(commandLine).map(classifySegment);
	// VS Code resolves `${command:...}` and `${input:...}` in task definitions by
	// running editor commands (which can push, sync or run other tasks) before
	// the shell ever sees the command line, so what they do is invisible here.
	if (/\$\{(command|input):/.test(commandLine)) {
		tiers.push(GovernanceRiskTier.RemoteInfra);
	}
	return maxTier(tiers);
}

//#endregion

//#region Tools

/** Tool owners, as they appear in {@link IGovernedAction.origin} (lowercased). */
const CORE = 'internal';
const COPILOT = 'github.copilot-chat';
const MERMAID = 'vscode.mermaid-markdown-features';

interface IKnownTool {
	/** The only origin allowed to register this id. Anyone else's tool under the same id is not trusted to behave the same. */
	readonly owner: string;
	readonly tier: GovernanceRiskTier;
}

function tools(owner: string, tier: GovernanceRiskTier, ids: readonly string[]): [string, IKnownTool][] {
	return ids.map(id => [id, { owner, tier }]);
}

/**
 * Tools whose effect is known without inspecting their input.
 *
 * Ids are string literals because the platform layer cannot import the
 * workbench constants they are defined by; each group names where its ids are
 * defined. The workbench tests for governed actions check the ids against those
 * constants where layering lets them. A tool missing from this table is a local
 * write. Tools that run a command line are listed at their floor; the command
 * line (see `governedActions.ts`) decides the rest.
 */
const KNOWN_TOOLS = new Map<string, IKnownTool>([
	// --- Core, read: no side effects, or chat-internal state only ---

	// vs/workbench/contrib/chat/common/tools/builtinTools/: todo list, asking the user, reviewing a plan,
	// ending a turn and session artifacts are chat state; a subagent's own tool calls pass through the gate.
	...tools(CORE, GovernanceRiskTier.Read, ['manage_todo_list', 'vscode_askQuestions', 'vscode_reviewPlan', 'task_complete', 'setArtifacts', 'setArtifactRules', 'runSubagent', 'vscode_resolveDebugEventDetails_internal']),
	// vs/workbench/contrib/chat/browser/tools/usagesTool.ts: language service query.
	...tools(CORE, GovernanceRiskTier.Read, ['vscode_listCodeUsages']),
	// vs/workbench/contrib/chat/common/tools/terminalToolIds.ts: read terminal and task output.
	...tools(CORE, GovernanceRiskTier.Read, ['get_terminal_output', 'terminal_selection', 'terminal_last_command', 'get_task_output']),
	// vs/workbench/contrib/testing/common/testingChatAgentTool.ts: reads the last test results.
	...tools(CORE, GovernanceRiskTier.Read, ['testFailure']),
	// vs/workbench/contrib/browserView/electron-browser/tools/: inspect pages that are already open, without navigating.
	...tools(CORE, GovernanceRiskTier.Read, ['list_browser_pages', 'read_page', 'screenshot_page']),
	// vs/sessions/contrib/automations/browser/automationTools.ts
	...tools(CORE, GovernanceRiskTier.Read, ['vscode_listAutomations']),

	// --- Core, local write ---

	// vs/workbench/contrib/chat/common/tools/builtinTools/editFileTool.ts, chat/browser/tools/renameTool.ts: workspace edits.
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['vscode_editFile_internal', 'vscode_renameSymbol']),
	// vs/workbench/contrib/chat/common/tools/builtinTools/confirmationTool.ts: only ask, but the answer authorizes
	// something the caller then does outside this gate (Copilot CLI uses them for MCP calls and file writes).
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['vscode_get_confirmation', 'vscode_get_confirmation_with_options', 'vscode_get_modified_files_confirmation']),
	// vs/workbench/contrib/chat/common/tools/builtinTools/tools.ts (InternalFetchWebPageToolId): fetches a
	// model-chosen URL, which can carry workspace data out in the request. Not a read.
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['vscode_fetchWebPage_internal']),
	// vs/workbench/contrib/extensions/common/searchExtensionsTool.ts: sends model-chosen text to the marketplace.
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['vscode_searchExtensions_internal']),
	// vs/workbench/contrib/chat/common/tools/terminalToolIds.ts: stopping a local process; the command tools are
	// floored here and classified by their command line (vscode_get_terminal_confirmation approves a command
	// Copilot CLI then runs itself, so its command line is the only look the gate gets).
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['kill_terminal', 'run_in_terminal', 'send_to_terminal', 'vscode_get_terminal_confirmation', 'create_and_run_task']),
	// vs/workbench/contrib/testing/common/testingChatAgentTool.ts: runs workspace test code, like `npm test`.
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['runTests']),
	// vs/workbench/contrib/browserView/electron-browser/tools/: navigate to model-chosen URLs or act on pages
	// (which may be signed in to something); run_playwright_code runs model-written script against them.
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['open_browser_page', 'navigate_page', 'click_element', 'drag_element', 'hover_element', 'type_in_page', 'handle_dialog', 'run_playwright_code']),
	// vs/workbench/contrib/chat/browser/chatSetup/chatSetupProviders.ts: placeholder that hands off to workspace scaffolding.
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['setup_tools_createNewWorkspace']),
	// vs/sessions/contrib/automations/browser/automationTools.ts: removes a saved schedule.
	...tools(CORE, GovernanceRiskTier.LocalWrite, ['vscode_deleteAutomation']),

	// --- Core, needs approval at the default threshold ---

	// vs/workbench/contrib/chat/common/tools/terminalToolIds.ts (RunTask): runs an existing workspace task by id.
	// Its command lives in tasks.json or a task provider, which the gate cannot see, and workspace tasks are
	// where deploys and releases are commonly defined. Treated as remote so it always gets a human decision.
	...tools(CORE, GovernanceRiskTier.RemoteInfra, ['run_task']),
	// vs/sessions/contrib/automations/browser/automationTools.ts: start or schedule unattended agent sessions,
	// possibly with a remote provider whose tool calls never reach this gate, and set their approval settings.
	...tools(CORE, GovernanceRiskTier.RemoteInfra, ['vscode_configureAutomation', 'vscode_runAutomation']),

	// --- Copilot Chat (extensions/copilot/package.json, ContributedToolName in src/extension/tools/common/toolNames.ts) ---

	// Workspace reads, language services, git diff, notebook reads, docs and setup steps; codebase and API search
	// send their query only to the Copilot service's own endpoints. Subagents' and skills' own tool calls are gated.
	...tools(COPILOT, GovernanceRiskTier.Read, [
		'copilot_searchCodebase', 'copilot_searchWorkspaceSymbols', 'copilot_getVSCodeAPI', 'copilot_findFiles', 'copilot_findTextInFiles',
		'copilot_readFile', 'copilot_viewImage', 'copilot_listDirectory', 'copilot_getErrors', 'copilot_readProjectStructure',
		'copilot_getChangedFiles', 'copilot_createNewWorkspace', 'copilot_getNotebookSummary', 'copilot_readNotebookCellOutput',
		'copilot_findTestFiles', 'copilot_switchAgent', 'copilot_resolveMemoryFileUri',
		'execution_subagent', 'search_subagent', 'explore_subagent', 'skill',
	]),
	// Workspace and notebook edits, memory files, the session index (reindex writes it).
	...tools(COPILOT, GovernanceRiskTier.LocalWrite, [
		'copilot_applyPatch', 'copilot_insertEdit', 'copilot_createFile', 'copilot_createDirectory', 'copilot_replaceString',
		'copilot_multiReplaceString', 'copilot_editNotebook', 'copilot_createNewJupyterNotebook', 'copilot_editFiles',
		'copilot_memory', 'copilot_sessionStoreSql',
	]),
	// Network with model-chosen input: a URL, or a GitHub repository or organization to search.
	...tools(COPILOT, GovernanceRiskTier.LocalWrite, ['copilot_fetchWebPage', 'copilot_githubRepo', 'copilot_githubTextSearch']),
	// Runs cell code in the notebook's kernel. The code is in the notebook, not the call (see the report on residual gaps).
	...tools(COPILOT, GovernanceRiskTier.LocalWrite, ['copilot_runNotebookCell']),
	// Installs third-party code that runs with the editor's privileges, outside the workspace.
	...tools(COPILOT, GovernanceRiskTier.LocalInfra, ['copilot_installExtension']),
	// Runs any editor command with any arguments (git.push, task runs, sending text to a terminal), which cannot
	// be judged from here. Meant only for new-workspace setup, so asking each time costs little.
	...tools(COPILOT, GovernanceRiskTier.RemoteInfra, ['copilot_runVscodeCommand']),

	// --- Mermaid (extensions/mermaid-markdown-features/package.json) ---
	...tools(MERMAID, GovernanceRiskTier.Read, ['renderMermaidDiagram']),
]);

/**
 * Origin prefix `governedToolAction` gives a tool contributed by an MCP server.
 */
const MCP_ORIGIN_PREFIX = 'mcp:';

function classifyTool(action: IGovernedAction): GovernanceRiskTier {
	// An MCP server's tool is third-party code reached over a protocol that says
	// nothing about what the tool does: `create_issue` and `delete_cluster` look
	// alike from here, and the server can add or change tools at any time. It is
	// treated the way `run_task` is — as something whose effect the gate cannot
	// see — so it always reaches a person rather than passing silently at the
	// default threshold. Lowering this for a server you trust is a per-tool rule
	// (D-006), not a default.
	if (action.origin.startsWith(MCP_ORIGIN_PREFIX)) {
		return GovernanceRiskTier.RemoteInfra;
	}

	const known = KNOWN_TOOLS.get(action.name);
	if (known === undefined) {
		// An unknown tool could do anything. Treat it as a local write so it is at
		// least recorded and gateable, never as a read.
		return GovernanceRiskTier.LocalWrite;
	}
	if (action.origin.toLowerCase() === known.owner) {
		return known.tier;
	}
	// Someone else's tool registered under a known id (possible when the owner
	// isn't installed) gets the unknown-tool default, but can't dodge a higher tier.
	return maxTier([known.tier, GovernanceRiskTier.LocalWrite]);
}

//#endregion

/**
 * Determines the risk tier of `action`.
 *
 * A tool call is as risky as the tool itself or the command line it runs,
 * whichever is riskier.
 *
 * Model requests are {@link GovernanceRiskTier.Read}: they have no effect on
 * the world. They pass through the gate anyway so that prompt content and cost
 * land in the audit log, which is the only place per-task spend can be
 * reconstructed.
 */
export function classifyAction(action: IGovernedAction): GovernanceRiskTier {
	if (action.kind === GovernedActionKind.Model) {
		return GovernanceRiskTier.Read;
	}

	const tiers = [classifyTool(action)];
	if (action.commandLine !== undefined) {
		tiers.push(classifyCommandLine(action.commandLine));
	}
	return maxTier(tiers);
}
