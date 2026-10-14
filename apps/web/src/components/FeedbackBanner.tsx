import type { Feedback } from '../lib/feedback';
import { formatDateTime } from '../lib/sale';

export function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  return (
    <div className={`feedback feedback--${feedback.tone}`}>
      <p className="feedback__title">{feedback.title}</p>
      {feedback.detail && <p className="feedback__detail">{feedback.detail}</p>}
      {feedback.order && (
        <dl className="feedback__order">
          <div>
            <dt>Order</dt>
            <dd>
              <code>{feedback.order.orderId}</code>
            </dd>
          </div>
          <div>
            <dt>Reserved</dt>
            <dd>{formatDateTime(feedback.order.purchasedAt)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
