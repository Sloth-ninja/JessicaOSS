"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    MfaVerificationPopup,
    needsMfaVerification,
} from "@/app/components/shared/MfaVerificationPopup";
import { isMfaRequiredError, MikeApiError } from "@/app/lib/mikeApi";
import {
    accountGlassIconButtonClassName,
    accountGlassInputClassName,
} from "../accountStyles";
import { AccountSection } from "../AccountSection";
import { FirmManagedCard, personalApiKeysBlocked } from "../firmPolicy";

function saveErrorMessage(
    action: "save" | "remove",
    label: string,
    error: unknown,
): string {
    if (error instanceof MikeApiError && error.message) {
        return `Could not ${action} ${label}: ${error.message}`;
    }
    return `Failed to ${action} ${label}.`;
}

const MODEL_API_KEY_FIELDS = [
    {
        provider: "claude",
        label: "Anthropic (Claude) API Key",
        placeholder: "sk-ant-...",
    },
    {
        provider: "gemini",
        label: "Google (Gemini) API Key",
        placeholder: "AI...",
    },
    {
        provider: "openai",
        label: "OpenAI API Key",
        placeholder: "sk-...",
    },
    {
        provider: "openrouter",
        label: "OpenRouter API Key",
        placeholder: "sk-or-...",
    },
    {
        provider: "companies_house",
        label: "Companies House API Key",
        description:
            "Free — register at developer.company-information.service.gov.uk.",
        placeholder: "Your Companies House API key",
    },
] as const;

export default function ApiKeysPage() {
    const { profile, updateApiKey } = useUserProfile();

    // Firm policy (WS8 PR B): the tab is hidden for members whose firm disables
    // personal keys, but a direct navigation still lands here — render a neutral
    // "managed by your firm" card rather than the editable form or an error.
    if (personalApiKeysBlocked(profile?.firm)) {
        return (
            <FirmManagedCard
                heading="API Keys"
                title="Managed by your firm"
                description={`Model access is provided by ${profile?.firm?.name ?? "your firm"}. There is no key to add or manage here. Ask your firm admin if you need a model that isn't listed.`}
            />
        );
    }

    return (
        <div>
            <h2 className="mb-3 text-2xl font-medium font-serif text-gray-900">
                API Keys
            </h2>
            <p className="text-sm text-gray-500 mb-4">
                You must provide your own API keys for the app to work or add
                your API keys into the .env file if you are running your own
                instance of JessicaOS. All API keys are encrypted in storage.
            </p>
            <AccountSection>
                {MODEL_API_KEY_FIELDS.map((field, index) => (
                    <div key={field.provider}>
                        <ApiKeyField
                            label={field.label}
                            description={
                                "description" in field
                                    ? field.description
                                    : undefined
                            }
                            placeholder={field.placeholder}
                            hasSavedKey={
                                !!profile?.apiKeys[field.provider].configured
                            }
                            isServerConfigured={
                                profile?.apiKeys[field.provider].source ===
                                "env"
                            }
                            isFirmProvided={
                                profile?.apiKeys[field.provider].source ===
                                "firm"
                            }
                            onSave={(value) =>
                                updateApiKey(
                                    field.provider,
                                    value.trim() || null,
                                )
                            }
                            onRemove={() => updateApiKey(field.provider, null)}
                        />
                        {index < MODEL_API_KEY_FIELDS.length - 1 && (
                            <div className="mx-4 h-px bg-gray-200" />
                        )}
                    </div>
                ))}
            </AccountSection>
        </div>
    );
}

function ApiKeyField({
    label,
    description,
    placeholder,
    hasSavedKey,
    isServerConfigured,
    isFirmProvided,
    onSave,
    onRemove,
}: {
    label: string;
    description?: string;
    placeholder: string;
    hasSavedKey: boolean;
    isServerConfigured: boolean;
    isFirmProvided: boolean;
    onSave: (value: string) => Promise<boolean>;
    onRemove: () => Promise<boolean>;
}) {
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [pendingMfaAction, setPendingMfaAction] = useState<
        "save" | "remove" | null
    >(null);

    useEffect(() => {
        setValue("");
    }, [hasSavedKey]);

    const dirty = value.trim().length > 0;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaAction("save");
                return;
            }
            const ok = await onSave(value);
            if (ok) {
                setValue("");
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
            } else {
                alert(`Failed to save ${label}.`);
            }
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingMfaAction("save");
            } else {
                alert(saveErrorMessage("save", label, error));
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleRemove = async () => {
        setIsSaving(true);
        try {
            if (await needsMfaVerification()) {
                setPendingMfaAction("remove");
                return;
            }
            const ok = await onRemove();
            if (!ok) alert(`Failed to remove ${label}.`);
        } catch (error) {
            if (isMfaRequiredError(error)) {
                setPendingMfaAction("remove");
            } else {
                alert(saveErrorMessage("remove", label, error));
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleMfaVerified = async () => {
        const action = pendingMfaAction;
        setPendingMfaAction(null);
        if (action === "save") {
            await handleSave();
        } else if (action === "remove") {
            await handleRemove();
        }
    };

    return (
        <>
            <div className="px-4 py-5">
                <label className="text-sm font-medium text-gray-700 block mb-2">
                    {label}
                </label>
                {description && (
                    <p className="text-sm text-gray-500 mb-3">{description}</p>
                )}
                {isFirmProvided && (
                    <p className="text-sm text-gray-500 mb-3">
                        Provided by your firm — your own key takes priority if
                        added.
                    </p>
                )}
                {isServerConfigured && (
                    <p className="text-sm text-gray-500 mb-3">
                        A server default is available. Add your own key to use
                        it instead — your key always takes priority.
                    </p>
                )}
                <div className="space-y-2">
                    <div className="relative flex-1">
                        <Input
                            type={reveal ? "text" : "password"}
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            placeholder={
                                isServerConfigured
                                    ? "Enter your own key to override the server default"
                                    : isFirmProvided
                                      ? "Enter your own key to override the firm key"
                                      : hasSavedKey
                                        ? "Saved key hidden"
                                        : placeholder
                            }
                            className={`pr-10 ${accountGlassInputClassName}`}
                            autoComplete="off"
                            spellCheck={false}
                        />
                        {dirty && (
                            <button
                                type="button"
                                onClick={() => setReveal((r) => !r)}
                                className={`absolute inset-y-1 right-1.5 flex items-center ${accountGlassIconButtonClassName}`}
                                aria-label={reveal ? "Hide key" : "Show key"}
                            >
                                {reveal ? (
                                    <EyeOff className="h-4 w-4" />
                                ) : (
                                    <Eye className="h-4 w-4" />
                                )}
                            </button>
                        )}
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={isSaving || !dirty || saved}
                            className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                        >
                            {isSaving ? (
                                "Saving..."
                            ) : saved ? (
                                "Saved"
                            ) : (
                                "Save"
                            )}
                        </button>
                        {hasSavedKey && !isServerConfigured && !isFirmProvided && (
                            <button
                                type="button"
                                onClick={handleRemove}
                                disabled={isSaving}
                                className="text-xs font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
                            >
                                Remove
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <MfaVerificationPopup
                open={!!pendingMfaAction}
                onCancel={() => setPendingMfaAction(null)}
                onVerified={() => void handleMfaVerified()}
            />
        </>
    );
}
