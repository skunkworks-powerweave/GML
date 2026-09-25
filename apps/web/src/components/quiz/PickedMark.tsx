// The check mark on a quiz runner's picked option (QuizRunner and
// MobileQuizRunner). The picked option used to be marked by colour alone --
// an ink/paper inversion on desktop, a saffron fill on a phone -- which is
// lost to anyone who cannot tell those colours apart (F135). A mark is a
// shape. It is hidden from assistive technology, which is told by the
// option's aria-pressed, and draws in the option's own text colour.

export function PickedMark() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={18}
      height={18}
      viewBox="0 0 16 16"
      style={{ marginLeft: "auto", flexShrink: 0 }}
    >
      <path
        d="M3 8.5l3.2 3.1L13 4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
