import { Field } from "./ui.tsx";
export function NumberField({
  label,
  value,
  onChange,
  nullable = false,
  step = "any",
  min = 0,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  nullable?: boolean;
  step?: string;
  min?: number;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={min}
        step={step}
        value={value ?? ""}
        onChange={(e) =>
          onChange(
            e.target.value === "" && nullable ? null : Number(e.target.value),
          )
        }
      />
    </Field>
  );
}
