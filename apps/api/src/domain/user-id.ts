export const USER_ID_MIN_LENGTH = 3;
export const USER_ID_MAX_LENGTH = 128;

const ALLOWED_CHARACTERS = /^[\p{L}\p{N}._@+-]+$/u;

export class InvalidUserIdError extends Error {
  override name = 'InvalidUserIdError';
}

/**
 * The canonical identity behind "one item per user": Unicode-normalised, trimmed and lower-cased,
 * so "Alice@Example.com " and "alice@example.com" are the same buyer.
 */
export function normalizeUserId(raw: string): string {
  const userId = raw.normalize('NFKC').trim().toLowerCase();

  if (userId.length < USER_ID_MIN_LENGTH || userId.length > USER_ID_MAX_LENGTH) {
    throw new InvalidUserIdError(
      `User ID must be between ${USER_ID_MIN_LENGTH} and ${USER_ID_MAX_LENGTH} characters long.`,
    );
  }
  if (!ALLOWED_CHARACTERS.test(userId)) {
    throw new InvalidUserIdError('User ID may only contain letters, numbers and . _ @ + -');
  }
  return userId;
}
