import type { Gender, PassengerInput, PassengerType, SavedPassenger } from '../lib/types';
import { PASSENGER_TYPE_LABEL } from '../lib/format';
import { Field } from './ui';

export const emptyPassenger = (type: PassengerType = 'adult'): PassengerInput => ({
  full_name: '',
  date_of_birth: '',
  gender: 'unspecified',
  nationality: '',
  passport_number: '',
  passport_expiry: '',
  passport_country: '',
  phone: '',
  email: '',
  passenger_type: type,
});

/**
 * One traveller's details.
 *
 * A returning customer picks themselves from the saved list instead of typing
 * their passport again; the server resolves that id to the real record, so the
 * full number never has to travel to the browser.
 */
export function PassengerFields({
  index, value, saved, usingSavedId, departDate, onChange, onUseSaved, onRemove,
}: {
  index: number;
  value: PassengerInput;
  saved: SavedPassenger[];
  usingSavedId: number | null;
  departDate: string;
  onChange: (patch: Partial<PassengerInput>) => void;
  onUseSaved: (id: number | null) => void;
  onRemove?: () => void;
}) {
  const expiryTooSoon =
    value.passport_expiry !== '' && departDate !== '' && value.passport_expiry < departDate;

  return (
    <div className="pax-card">
      <div className="pax-card-head">
        <strong>
          Passenger {index + 1}
          <span className="pax-type-tag">{PASSENGER_TYPE_LABEL[value.passenger_type]}</span>
        </strong>
        {onRemove ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>Remove</button>
        ) : null}
      </div>

      {saved.length > 0 ? (
        <Field label="Traveller" hint="Pick someone already on file, or enter new details">
          {(id) => (
            <select
              id={id}
              className="select"
              value={usingSavedId ?? ''}
              onChange={(event) => onUseSaved(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">Enter new details</option>
              {saved.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.full_name}
                  {person.passport_masked ? ` — passport ${person.passport_masked}` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}

      {usingSavedId ? (
        <p className="field-hint">
          Using the details already on file. Choose “Enter new details” to change them.
        </p>
      ) : (
        <div className="pax-grid-form">
          <Field label="Full name (as in passport)">
            {(id) => (
              <input id={id} className="input" required autoComplete="off" value={value.full_name}
                onChange={(event) => onChange({ full_name: event.target.value })} />
            )}
          </Field>

          <Field label="Passenger type">
            {(id) => (
              <select id={id} className="select" value={value.passenger_type}
                onChange={(event) => onChange({ passenger_type: event.target.value as PassengerType })}>
                <option value="adult">Adult</option>
                <option value="child">Child</option>
                <option value="infant">Infant</option>
              </select>
            )}
          </Field>

          <Field label="Date of birth">
            {(id) => (
              <input id={id} className="input" type="date" required value={value.date_of_birth}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(event) => onChange({ date_of_birth: event.target.value })} />
            )}
          </Field>

          <Field label="Gender">
            {(id) => (
              <select id={id} className="select" value={value.gender}
                onChange={(event) => onChange({ gender: event.target.value as Gender })}>
                <option value="unspecified">Prefer not to say</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
              </select>
            )}
          </Field>

          <Field label="Nationality">
            {(id) => (
              <input id={id} className="input" required value={value.nationality}
                onChange={(event) => onChange({ nationality: event.target.value })} />
            )}
          </Field>

          <Field label="Passport number">
            {(id) => (
              <input id={id} className="input" required autoComplete="off" value={value.passport_number}
                onChange={(event) => onChange({ passport_number: event.target.value })} />
            )}
          </Field>

          <Field
            label="Passport expiry"
            error={expiryTooSoon ? 'This passport expires before the flight departs' : undefined}
          >
            {(id) => (
              <input id={id} className="input" type="date" required value={value.passport_expiry}
                onChange={(event) => onChange({ passport_expiry: event.target.value })} />
            )}
          </Field>

          <Field label="Passport issuing country">
            {(id) => (
              <input id={id} className="input" required value={value.passport_country}
                onChange={(event) => onChange({ passport_country: event.target.value })} />
            )}
          </Field>

          <Field label="Phone">
            {(id) => (
              <input id={id} className="input" type="tel" required value={value.phone}
                onChange={(event) => onChange({ phone: event.target.value })} />
            )}
          </Field>

          <Field label="Email" hint="Optional">
            {(id) => (
              <input id={id} className="input" type="email" value={value.email}
                onChange={(event) => onChange({ email: event.target.value })} />
            )}
          </Field>
        </div>
      )}
    </div>
  );
}
