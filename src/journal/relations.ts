/** Deterministic projection over explicit journal relations. */
import type { JournalRecord, JournalRelationType } from "./record.ts";

export const RELATION_LABELS = [
	"correction",
	"corrected",
	"superseded",
	"annotated",
	"conflict",
	"cycle",
	"missing-target",
	"retired-member",
	"retired-host",
] as const;

export type RelationLabel = (typeof RELATION_LABELS)[number];

export const JOURNAL_TRUST_LABELS = [
	"local-user",
	"local-agent",
	"local-other",
	"teammate-user",
	"teammate-agent",
	"teammate-other",
] as const;

export type JournalTrust = (typeof JOURNAL_TRUST_LABELS)[number];

export interface RelationLifecycle {
	retiredMembers: ReadonlySet<string>;
	retiredHosts: ReadonlySet<string>;
}

export interface RelationEdge {
	from: string;
	to: string;
	type: JournalRelationType;
}

export interface RelationView {
	record: JournalRecord;
	incoming: RelationEdge[];
	outgoing: RelationEdge[];
	labels: RelationLabel[];
	trust: JournalTrust;
}

export interface RelationProjection {
	views: Map<string, RelationView>;
	conflicts: Array<{ target: string; records: string[] }>;
	cycles: string[][];
	missing: RelationEdge[];
}

export function trustLabel(record: JournalRecord, localMember: string): JournalTrust {
	const actor = record.member === localMember ? "local" : "teammate";
	const source = record.source === "user" ? "user" : record.source === "agent" ? "agent" : "other";
	return `${actor}-${source}`;
}

export function projectRelations(
	records: readonly JournalRecord[],
	localMember: string,
	lifecycle?: RelationLifecycle,
): RelationProjection {
	const views = new Map<string, RelationView>();
	for (const record of [...records].sort(byRecord)) {
		if (views.has(record.id)) continue;
		views.set(record.id, { record, incoming: [], outgoing: [], labels: [], trust: trustLabel(record, localMember) });
	}
	for (const view of views.values()) {
		if (lifecycle?.retiredMembers.has(view.record.member)) addLabel(view, "retired-member");
		if (lifecycle?.retiredHosts.has(view.record.host)) addLabel(view, "retired-host");
	}

	const missing: RelationEdge[] = [];
	for (const view of views.values()) {
		for (const relation of view.record.relations) {
			const edge = { from: view.record.id, to: relation.target, type: relation.type };
			view.outgoing.push(edge);
			const target = views.get(relation.target);
			if (target) target.incoming.push(edge);
			else {
				missing.push(edge);
				addLabel(view, "missing-target");
			}
			addLabel(view, "correction");
		}
	}

	const conflicts: RelationProjection["conflicts"] = [];
	const superseded = new Set(
		[...views.values()].flatMap((candidate) =>
			candidate.outgoing.filter((edge) => edge.type === "supersedes").map((edge) => edge.to),
		),
	);
	for (const view of views.values()) {
		for (const edge of view.incoming) {
			addLabel(view, edge.type === "corrects" ? "corrected" : edge.type === "supersedes" ? "superseded" : "annotated");
		}
		const disputing = view.incoming.filter(
			(edge) =>
				(edge.type === "corrects" ||
					(edge.type === "supersedes" &&
						!views.get(edge.from)?.outgoing.some((candidate) => candidate.type === "corrects"))) &&
				!superseded.has(edge.from),
		);
		if (disputing.length > 1) {
			const records = disputing.map((edge) => edge.from).sort();
			conflicts.push({ target: view.record.id, records });
			addLabel(view, "conflict");
			for (const id of records) addLabel(views.get(id), "conflict");
		}
		view.incoming.sort(byEdge);
		view.outgoing.sort(byEdge);
	}

	const cycles = findCycles(views);
	for (const cycle of cycles) for (const id of cycle) addLabel(views.get(id), "cycle");
	for (const view of views.values())
		view.labels.sort((left, right) => RELATION_LABELS.indexOf(left) - RELATION_LABELS.indexOf(right));
	conflicts.sort((left, right) => left.target.localeCompare(right.target));
	missing.sort(byEdge);
	return { views, conflicts, cycles, missing };
}

function byRecord(left: JournalRecord, right: JournalRecord): number {
	return left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
}

function byEdge(left: RelationEdge, right: RelationEdge): number {
	return left.type.localeCompare(right.type) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
}

function addLabel(view: RelationView | undefined, label: RelationLabel): void {
	if (view && !view.labels.includes(label)) view.labels.push(label);
}

/** Tarjan strongly connected components; a self-edge is a one-node cycle. */
function findCycles(views: ReadonlyMap<string, RelationView>): string[][] {
	let next = 0;
	const indexes = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const stacked = new Set<string>();
	const cycles: string[][] = [];

	const visit = (id: string): void => {
		indexes.set(id, next);
		low.set(id, next);
		next++;
		stack.push(id);
		stacked.add(id);
		for (const edge of views.get(id)?.outgoing ?? []) {
			if (!views.has(edge.to)) continue;
			if (!indexes.has(edge.to)) {
				visit(edge.to);
				low.set(id, Math.min(low.get(id) as number, low.get(edge.to) as number));
			} else if (stacked.has(edge.to)) {
				low.set(id, Math.min(low.get(id) as number, indexes.get(edge.to) as number));
			}
		}
		if (low.get(id) !== indexes.get(id)) return;
		const component: string[] = [];
		while (stack.length > 0) {
			const member = stack.pop() as string;
			stacked.delete(member);
			component.push(member);
			if (member === id) break;
		}
		const self = component.length === 1 && (views.get(id)?.outgoing.some((edge) => edge.to === id) ?? false);
		if (component.length > 1 || self) cycles.push(component.sort());
	};

	for (const id of [...views.keys()].sort()) if (!indexes.has(id)) visit(id);
	return cycles.sort((left, right) => (left[0] as string).localeCompare(right[0] as string));
}

export interface RelationNeighborhood {
	records: RelationView[];
	truncated: boolean;
}

/** Read one record and a bounded incoming/outgoing relation neighborhood. */
export function relationNeighborhood(
	projection: RelationProjection,
	id: string,
	options: { depth?: number; limit?: number } = {},
): RelationNeighborhood | undefined {
	if (!projection.views.has(id)) return undefined;
	const depth = Math.max(0, Math.min(options.depth ?? 1, 5));
	const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
	const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];
	const seen = new Set<string>();
	const records: RelationView[] = [];
	let truncated = false;
	while (queue.length > 0) {
		const current = queue.shift() as { id: string; depth: number };
		if (seen.has(current.id)) continue;
		seen.add(current.id);
		const view = projection.views.get(current.id);
		if (!view) continue;
		if (records.length >= limit) {
			truncated = true;
			break;
		}
		records.push(view);
		if (current.depth >= depth) continue;
		const adjacent = [...view.incoming.map((edge) => edge.from), ...view.outgoing.map((edge) => edge.to)].sort();
		for (const adjacentId of adjacent) queue.push({ id: adjacentId, depth: current.depth + 1 });
	}
	return { records, truncated };
}

/** User corrections rank immediately before their target; conflicts tie by ID. */
export function correctionRank(record: JournalRecord, projection: RelationProjection): number {
	const view = projection.views.get(record.id);
	if (!view || record.source !== "user") return 0;
	if (view.outgoing.some((edge) => edge.type === "supersedes")) return 30;
	if (view.outgoing.some((edge) => edge.type === "corrects")) return 20;
	if (view.outgoing.some((edge) => edge.type === "annotates")) return 10;
	return 0;
}
