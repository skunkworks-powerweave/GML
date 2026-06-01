# Research 048

Promoted the JSX prototype's inline "Learners (sample)" SectionCard into its own sub-route `/repo/class/[id]/learners` so the SM-9 role gate (super_admin + programme_admin only) and recordAudit hook fire only when a privileged user explicitly navigates to the roster — keeping the class detail page itself unguarded and broadly visible.
