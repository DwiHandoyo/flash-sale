import { useId, useState, type FormEvent } from 'react';

import { attemptPurchase, lookupPurchase, SalePausedError, type SaleStatus } from '../api';
import {
  feedbackForLookup,
  feedbackForPurchase,
  SALE_PAUSED,
  UNCONFIRMED_PURCHASE,
  type Feedback,
} from '../lib/feedback';
import { FeedbackBanner } from './FeedbackBanner';

const STORAGE_KEY = 'flash-sale:user-id';
const MIN_USER_ID_LENGTH = 3;

const BUY_LABELS: Record<SaleStatus, string> = {
  upcoming: 'Not open yet',
  active: 'Buy now',
  sold_out: 'Sold out',
  ended: 'Sale ended',
  paused: 'Paused',
};

interface Props {
  status: SaleStatus | null;
  /** Called after every purchase attempt, e.g. to refresh the stock count. */
  onPurchaseSettled: () => void;
}

export function PurchasePanel({ status, onPurchaseSettled }: Props) {
  const inputId = useId();
  const hintId = useId();
  const [userId, setUserId] = useState(readStoredUserId);
  const [pending, setPending] = useState<'buy' | 'check' | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const trimmedUserId = userId.trim();
  const canSubmit = trimmedUserId.length >= MIN_USER_ID_LENGTH && pending === null;

  async function buy(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || status !== 'active') return;

    storeUserId(trimmedUserId);
    setPending('buy');
    setFeedback(null);
    try {
      setFeedback(feedbackForPurchase(await attemptPurchase(trimmedUserId)));
    } catch {
      // The purchase may have gone through before the connection failed: ask, don't guess.
      setFeedback(await confirmAfterFailure(trimmedUserId));
    } finally {
      setPending(null);
      onPurchaseSettled();
    }
  }

  async function check() {
    if (!canSubmit) return;

    storeUserId(trimmedUserId);
    setPending('check');
    setFeedback(null);
    try {
      setFeedback(feedbackForLookup(await lookupPurchase(trimmedUserId)));
    } catch (error) {
      if (error instanceof SalePausedError) return setFeedback(SALE_PAUSED);
      setFeedback({
        tone: 'error',
        title: 'Could not check your purchase',
        detail: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <form className="purchase" onSubmit={(event) => void buy(event)} noValidate>
      <label htmlFor={inputId}>Your username or email</label>
      <input
        id={inputId}
        name="userId"
        value={userId}
        onChange={(event) => setUserId(event.target.value)}
        placeholder="e.g. alice@example.com"
        autoComplete="username"
        maxLength={128}
        aria-describedby={hintId}
      />
      <p id={hintId} className="hint">
        Limited to one per customer.
      </p>

      <div className="actions">
        <button
          type="submit"
          className="button button--primary"
          disabled={!canSubmit || status !== 'active'}
        >
          {pending === 'buy' ? 'Securing your item…' : BUY_LABELS[status ?? 'active']}
        </button>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void check()}
          disabled={!canSubmit}
        >
          {pending === 'check' ? 'Checking…' : 'Check my purchase'}
        </button>
      </div>

      <div aria-live="polite">{feedback && <FeedbackBanner feedback={feedback} />}</div>
    </form>
  );
}

async function confirmAfterFailure(userId: string): Promise<Feedback> {
  try {
    const lookup = await lookupPurchase(userId);
    if (lookup.purchased) return feedbackForLookup(lookup);
  } catch {
    // Still unreachable; fall through.
  }
  return UNCONFIRMED_PURCHASE;
}

function readStoredUserId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeUserId(userId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, userId);
  } catch {
    // Storage can be unavailable (private mode); remembering the ID is only a convenience.
  }
}
