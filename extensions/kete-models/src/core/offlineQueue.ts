/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Kete Workbench contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatRequest, ChatUsage, ModelTier, ResponsePart } from './types';

// The offline request queue (roadmap, Tier 0) is specified here but not built.
//
// Interactive requests can't be queued: the chat response has to be produced
// while the person waits, so when the cloud is offline Kete Auto answers with
// the local model instead (see `routeRequest`). A queue only helps work that
// nobody is waiting on, such as a background review or an overnight summary.
// No such caller exists yet, and a queue with no consumer can't be tested
// against real use. It should be built together with its first caller (a
// background agent), against this contract.

/** A frontier-tier request, deferred until the cloud is reachable. */
export interface DeferredModelRequest {
	/** Chosen by the caller; used to collect the result. */
	readonly id: string;
	/** Which tier the request needs; queued only when that tier is unreachable. */
	readonly tier: ModelTier.Mid | ModelTier.Frontier;
	readonly request: ChatRequest;
	/** When the request was queued (ms since the epoch). */
	readonly queuedAt: number;
	/** The request is dropped, not sent, after this time (ms since the epoch). */
	readonly expiresAt: number;
	/** The extension or client that queued it, recorded in the governance audit when it is sent. */
	readonly origin: string;
}

/** The outcome of a deferred request. */
export type DeferredModelResult =
	| { readonly status: 'completed'; readonly parts: readonly ResponsePart[]; readonly usage: ChatUsage }
	| { readonly status: 'failed'; readonly message: string }
	| { readonly status: 'expired' };

/**
 * A disk-persisted queue of deferrable requests.
 *
 * Constraints for an implementation:
 * - Requests are persisted with the same care as prompts: in the user's global
 *   storage, never in the workspace, and never containing credentials.
 * - Sending a queued request must go through the language model API like any
 *   other request, so the governance gate records it when it is actually sent.
 * - Draining starts when the cloud connectivity monitor reports `Online`, one
 *   request at a time, so a reconnect doesn't burst.
 * - A person must be able to see and discard queued requests, because each one
 *   will cost money when it is sent.
 */
export interface DeferredRequestQueue {
	enqueue(request: DeferredModelRequest): Promise<void>;
	/** Queued requests, oldest first. */
	list(): Promise<readonly DeferredModelRequest[]>;
	discard(id: string): Promise<void>;
	/** Resolves once the request has been sent and completed, failed or expired. */
	result(id: string): Promise<DeferredModelResult>;
}
