/**
 * A serial queue for journal writes.
 *
 * Capture runs inside pi's event handlers, and awaiting an append there would
 * put the store lock on the user's critical path: an append normally takes
 * milliseconds, but under contention with another pi session it can wait
 * seconds, and stalling someone's keystroke to record a note about it is the
 * wrong trade.
 *
 * So appends are queued and the handler returns immediately. The queue is
 * serial rather than parallel because two appends racing would both wait on
 * the same store lock anyway, and because entries written in the order they
 * were observed are easier to reason about.
 *
 * The cost of not awaiting is that a process exiting mid-write loses the
 * entry. `flush()` on `session_shutdown` closes that window.
 */

export interface QueueFailure {
	label: string;
	message: string;
}

export class AppendQueue {
	private tail: Promise<void> = Promise.resolve();
	private readonly failures: QueueFailure[] = [];
	private pending = 0;

	/**
	 * Schedule work. Never rejects: a failed append is recorded and reported
	 * through `/muninn`, not thrown into one of pi's event handlers, where it
	 * would surface as an extension crash rather than as "memory is not
	 * working".
	 */
	enqueue(label: string, work: () => Promise<void>): void {
		this.pending++;
		this.tail = this.tail.then(async () => {
			try {
				await work();
			} catch (error) {
				this.failures.push({ label, message: error instanceof Error ? error.message : String(error) });
			} finally {
				this.pending--;
			}
		});
	}

	/** Wait for everything queued so far. */
	async flush(): Promise<void> {
		await this.tail;
	}

	/** Appends still in flight. */
	get inFlight(): number {
		return this.pending;
	}

	/** Failures since the last `takeFailures()`. */
	takeFailures(): QueueFailure[] {
		return this.failures.splice(0, this.failures.length);
	}

	/** Failures without clearing them, for status display. */
	peekFailures(): readonly QueueFailure[] {
		return this.failures;
	}
}
