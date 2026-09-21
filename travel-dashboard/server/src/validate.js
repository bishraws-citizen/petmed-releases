/** Thrown for any client-correctable problem; the error handler maps it to 400. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const notFound = (what) => new HttpError(404, `${what} not found`);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function field(body, name, { type, required = true, values, min, max, fallback }) {
  const raw = body?.[name];

  if (raw === undefined || raw === null || raw === '') {
    if (required) throw badRequest(`"${name}" is required`);
    return fallback;
  }

  switch (type) {
    case 'string': {
      const value = String(raw).trim();
      if (required && value === '') throw badRequest(`"${name}" is required`);
      if (max && value.length > max) throw badRequest(`"${name}" must be at most ${max} characters`);
      return value;
    }
    case 'int': {
      const value = Number(raw);
      if (!Number.isInteger(value)) throw badRequest(`"${name}" must be a whole number`);
      if (min !== undefined && value < min) throw badRequest(`"${name}" must be at least ${min}`);
      if (max !== undefined && value > max) throw badRequest(`"${name}" must be at most ${max}`);
      return value;
    }
    case 'money': {
      const value = Math.round(Number(raw));
      if (!Number.isFinite(value)) throw badRequest(`"${name}" must be an amount`);
      if (value < (min ?? 0)) throw badRequest(`"${name}" must be at least ${min ?? 0}`);
      return value;
    }
    case 'date': {
      const value = String(raw).slice(0, 10);
      if (!DATE_RE.test(value)) throw badRequest(`"${name}" must be a YYYY-MM-DD date`);
      return value;
    }
    case 'enum': {
      const value = String(raw);
      if (!values.includes(value)) {
        throw badRequest(`"${name}" must be one of: ${values.join(', ')}`);
      }
      return value;
    }
    case 'email': {
      const value = String(raw).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw badRequest(`"${name}" must be an email address`);
      return value;
    }
    default:
      throw new Error(`unknown field type ${type}`);
  }
}

/** Reject a trip whose return falls before its departure. */
export function assertRange(startName, start, endName, end) {
  if (end < start) throw badRequest(`"${endName}" cannot be before "${startName}"`);
}

export function intParam(value, what) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw badRequest(`invalid ${what} id`);
  return id;
}
