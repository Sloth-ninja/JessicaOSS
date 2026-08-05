"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MikeApiError } from "@/app/lib/mikeApi";
import { Modal } from "../shared/Modal";
import { PRACTICE_OPTIONS } from "../workflows/practices";

/**
 * Name + practice-area form shared by every "template details" flow: the
 * Templates page's New template and Rename, and Save as template from a review
 * grid (which wraps this in SaveAsTemplateModal). Practice areas follow the
 * workflow modal's pill idiom, including the free-text "Others" escape hatch.
 */

interface Props {
    open: boolean;
    /** Second breadcrumb, e.g. "New template". */
    action: string;
    /** Optional explanatory line under the name field. */
    hint?: ReactNode;
    initialName?: string;
    initialPractice?: string | null;
    submitLabel: string;
    submittingLabel: string;
    onClose: () => void;
    onSubmit: (values: {
        name: string;
        practice: string | null;
    }) => Promise<void>;
}

/**
 * Mounts the form only while open, so its initial values come from props at
 * mount time — no state-syncing effect, and reopening always starts clean.
 */
export function TemplateDetailsModal(props: Props) {
    if (!props.open) return null;
    return <TemplateDetailsForm {...props} />;
}

function TemplateDetailsForm({
    open,
    action,
    hint,
    initialName = "",
    initialPractice = null,
    submitLabel,
    submittingLabel,
    onClose,
    onSubmit,
}: Props) {
    const savedPractice = initialPractice ?? "";
    const practiceIsKnown = (PRACTICE_OPTIONS as readonly string[]).includes(
        savedPractice,
    );
    const [name, setName] = useState(initialName);
    const [practice, setPractice] = useState(
        savedPractice && !practiceIsKnown ? "Others" : savedPractice,
    );
    const [customPractice, setCustomPractice] = useState(
        savedPractice && !practiceIsKnown ? savedPractice : "",
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const customInputRef = useRef<HTMLInputElement>(null);

    const isOthers = practice === "Others";
    const effectivePractice = isOthers
        ? customPractice.trim() || null
        : practice || null;
    const formId = "template-details-modal-form";

    useEffect(() => {
        if (isOthers) customInputRef.current?.focus();
    }, [isOthers]);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim() || saving) return;
        setSaving(true);
        setError("");
        try {
            await onSubmit({
                name: name.trim(),
                practice: effectivePractice,
            });
        } catch (err) {
            // Only MikeApiError carries a server detail (user-safe by
            // construction). A bare Error here is a network/runtime failure —
            // surfacing its message would render internals as user copy.
            setError(
                err instanceof MikeApiError && err.message
                    ? err.message
                    : "Could not save the template. Please try again.",
            );
            setSaving(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={saving ? () => undefined : onClose}
            breadcrumbs={["Templates", action]}
            primaryAction={{
                label: saving ? submittingLabel : submitLabel,
                type: "submit",
                form: formId,
                disabled: !name.trim() || saving,
            }}
        >
            <form
                id={formId}
                onSubmit={handleSubmit}
                className="flex min-h-0 flex-1 flex-col"
            >
                <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Template name"
                    maxLength={200}
                    className="w-full bg-transparent font-serif text-2xl text-gray-800 placeholder-gray-300 focus:outline-none"
                    autoFocus
                />

                {hint && (
                    <p className="mt-2 text-xs leading-relaxed text-gray-500">
                        {hint}
                    </p>
                )}

                <div className="mt-5">
                    <p className="mb-2 text-sm font-medium text-gray-500">
                        Practice area{" "}
                        <span className="font-normal text-gray-400">
                            (optional)
                        </span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {PRACTICE_OPTIONS.map((option) => (
                            <button
                                key={option}
                                type="button"
                                onClick={() =>
                                    setPractice(
                                        practice === option ? "" : option,
                                    )
                                }
                                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                                    practice === option
                                        ? "border-gray-900 bg-gray-900 text-white"
                                        : "border-gray-200 text-gray-600 hover:bg-gray-50"
                                }`}
                            >
                                {option}
                            </button>
                        ))}
                    </div>
                    {isOthers && (
                        <input
                            ref={customInputRef}
                            type="text"
                            value={customPractice}
                            onChange={(e) => setCustomPractice(e.target.value)}
                            placeholder="Enter practice area…"
                            maxLength={120}
                            className="mt-3 w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 placeholder-gray-400 focus:border-gray-400 focus:outline-none"
                        />
                    )}
                </div>

                {error && <p className="mt-4 text-sm text-red-500">{error}</p>}
            </form>
        </Modal>
    );
}
