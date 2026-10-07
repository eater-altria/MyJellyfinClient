export default function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`ios-toggle no-drag ${on ? 'on' : ''} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      onClick={() => onChange?.(!on)}
    />
  );
}
