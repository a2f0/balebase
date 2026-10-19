import { type InputHTMLAttributes, type ReactNode, useState } from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";

/** A labelled control. The label wraps its control, so no id is needed. */
export function Field({
  children,
  className,
  hint,
  label,
  optional = false,
}: {
  children: ReactNode;
  className?: string | undefined;
  hint?: ReactNode;
  label: ReactNode;
  optional?: boolean | undefined;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass the control as children.
    <label className={cx("field", className)}>
      <span className="fieldLabel">
        {label}
        {optional && (
          <>
            {" "}
            <span className="fieldOptional">Optional</span>
          </>
        )}
      </span>
      {children}
      {hint && <span className="fieldHint">{hint}</span>}
    </label>
  );
}

/**
 * A labelled password input with a button that shows or hides what was typed.
 * A button cannot sit inside a label, so this labels the input by its id and
 * keeps the toggle beside it; the toggle reports its state with aria-pressed.
 */
export function PasswordField({
  className,
  hint,
  id,
  label,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type"> & {
  className?: string | undefined;
  hint?: ReactNode;
  id: string;
  label: ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cx("field", className)}>
      <label className="fieldLabel" htmlFor={id}>
        {label}
      </label>
      <div className="passwordInput">
        <input
          {...input}
          aria-describedby={hintId}
          // A revealed password is plain text; keep it away from spelling and
          // autocorrect services that may send what is typed elsewhere.
          autoCapitalize="none"
          autoCorrect="off"
          className="input"
          id={id}
          spellCheck={false}
          type={visible ? "text" : "password"}
        />
        <button
          aria-controls={id}
          aria-label="Show password"
          aria-pressed={visible}
          className="passwordToggle"
          onClick={() => setVisible((shown) => !shown)}
          title={visible ? "Hide password" : "Show password"}
          type="button"
        >
          <Icon name={visible ? "eyeOff" : "eye"} size={18} />
        </button>
      </div>
      {hint && (
        <span className="fieldHint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}
