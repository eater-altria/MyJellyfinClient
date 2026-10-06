export default function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="switch"
      aria-checked={on}
      className={`ios-toggle no-drag ${on ? 'on' : ''} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      onClick={() => !disabled && onChange?.(!on)}
    />
  );
}
