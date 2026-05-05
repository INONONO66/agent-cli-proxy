import type { Database } from "bun:sqlite";
import { Storage } from "./db";

export namespace AccountSubscriptionRepo {
  export interface AccountSubscription {
    cliproxy_account: string;
    subscription_code: string;
    bound_at: string;
  }

  export function bind(
    db: Database,
    cliproxyAccount: string,
    subscriptionCode: string,
  ): void {
    Storage.runWriteWithRetry(db, () => {
      db.prepare(`
        INSERT INTO account_subscriptions (
          cliproxy_account, subscription_code, bound_at
        ) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(cliproxy_account) DO UPDATE SET
          subscription_code = excluded.subscription_code,
          bound_at = CURRENT_TIMESTAMP
      `).run(cliproxyAccount, subscriptionCode);
    });
  }

  export function unbind(db: Database, cliproxyAccount: string): void {
    Storage.runWriteWithRetry(db, () => {
      db.prepare("DELETE FROM account_subscriptions WHERE cliproxy_account = ?")
        .run(cliproxyAccount);
    });
  }

  export function get(
    db: Database,
    cliproxyAccount: string,
  ): AccountSubscription | null {
    return db.prepare(`
      SELECT cliproxy_account, subscription_code, bound_at
      FROM account_subscriptions
      WHERE cliproxy_account = ?
    `).get(cliproxyAccount) as AccountSubscription | null;
  }

  export function list(db: Database): AccountSubscription[] {
    return db.prepare(`
      SELECT cliproxy_account, subscription_code, bound_at
      FROM account_subscriptions
      ORDER BY cliproxy_account ASC
    `).all() as AccountSubscription[];
  }
}
