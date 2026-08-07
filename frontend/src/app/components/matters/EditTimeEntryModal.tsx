"use client";

// Edit one of the caller's OWN, unbilled time entries.
//
// The duration is collected in minutes — that is the unit the API takes, and
// the backend converts to the seconds Clio stores. The entry's ETag rides along
// so a colleague's concurrent change in Clio is refused rather than overwritten;
// that refusal comes back as a fixed "reload and try again" detail, and this
// modal offers the reload.

import { useState } from "react";
import { Modal } from "@/app/components/shared/Modal";
import {
    updateClioActivity,
    MikeApiError,
    type ClioActivity,
} from "@/app/lib/mikeApi";
import { secondsToMinutes, toDateInputValue } from "@/app/lib/clioMatters";

interface Props {
    /** Mount this component with `key={entry.id}` so the form re-initialises
     *  for each entry — no effect, and therefore no setState-in-effect. */
    entry: ClioActivity;
    onClose: () => void;
    onSaved: (updated: ClioActivity) => void;
    /** Re-fetches the list after a concurrency refusal. */
    onReload: () => void;
}

export function EditTimeEntryModal({
    entry,
    onClose,
    onSaved,
    onReload,
}: Props) {
    const [minutes, setMinutes] = useState(() =>
        entry.quantitySeconds === null
            ? ""
            : String(secondsToMinutes(entry.quantitySeconds)),
    );
    const [note, setNote] = useState(entry.note ?? "");
    const [date, setDate] = useState(() => toDateInputValue(entry.date));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [conflicted, setConflicted] = useState(false);

    const parsedMinutes = Number(minutes);
    const minutesValid =
        minutes.trim() !== "" &&
        Number.isFinite(parsedMinutes) &&
        parsedMinutes > 0;

    const originalMinutes = secondsToMinutes(entry.quantitySeconds);
    const originalDate = toDateInputValue(entry.date);
    const minutesChanged = Math.round(parsedMinutes) !== originalMinutes;
    const noteChanged = note !== (entry.note ?? "");
    const dateChanged = date !== originalDate;
    const nothingChanged = !minutesChanged && !noteChanged && !dateChanged;

    async function handleSave() {
        if (!minutesValid || nothingChanged) return;
        setSaving(true);
        setError(null);
        setConflicted(false);
        try {
            // Send only what actually changed: an unchanged field in the
            // payload is still a write Clio must apply, and the server rejects
            // an empty patch rather than making a pointless round-trip.
            const updated = await updateClioActivity(entry.id, {
                ...(minutesChanged
                    ? { minutes: Math.round(parsedMinutes) }
                    : {}),
                ...(noteChanged ? { note } : {}),
                ...(dateChanged && date ? { date } : {}),
                etag: entry.etag,
            });
            setSaving(false);
            onSaved(updated);
            onClose();
        } catch (err) {
            setSaving(false);
            // Fixed, user-safe details from the server (the #72 pattern).
            // Only a CONFLICT is answered by reloading — 409 (billed) or 412
            // (the entry moved under us). A 400 is a validation complaint about
            // what was typed, so the message is shown and the edit is KEPT:
            // offering "Reload" there would throw the user's work away.
            const status = err instanceof MikeApiError ? err.status : 0;
            setConflicted(status === 409 || status === 412);
            setError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not save this time entry. Please try again.",
            );
        }
    }

    return (
        <Modal
            open
            onClose={saving ? () => {} : onClose}
            breadcrumbs={["Time entry", "Edit"]}
            primaryAction={{
                label: saving ? "Saving…" : "Save to Clio",
                onClick: () => void handleSave(),
                disabled: !minutesValid || saving || nothingChanged,
            }}
            cancelAction={{ label: "Cancel", onClick: onClose }}
        >
            <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-gray-700">
                        Duration (minutes)
                    </span>
                    <input
                        type="number"
                        min={1}
                        step={1}
                        value={minutes}
                        onChange={(e) => setMinutes(e.target.value)}
                        autoFocus
                        className="w-40 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-400"
                    />
                    <span className="text-[11px] text-gray-400">
                        Saved to Clio in its own units. 6 minutes = 0.10h.
                    </span>
                </label>

                <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-gray-700">
                        Description
                    </span>
                    <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={4}
                        className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-400"
                    />
                </label>

                <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-gray-700">
                        Date
                    </span>
                    <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        className="w-48 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-400"
                    />
                </label>

                {error && (
                    <div className="flex flex-col items-start gap-2">
                        <p className="text-sm text-red-500">{error}</p>
                        {conflicted && (
                            <button
                                type="button"
                                onClick={() => {
                                    onReload();
                                    onClose();
                                }}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
                            >
                                Reload time entries
                            </button>
                        )}
                    </div>
                )}
            </div>
        </Modal>
    );
}
