import { createClerkClient } from '@clerk/backend';
import { AccountDeletionRepository } from '../db/repositories/account-deletion-repository.js';
import { parseConfirmation } from './contract.js';
import { AppleGrantRevoker } from './apple.js';
import { ServiceError } from '../errors.js';

export class AccountDeletionService {
  private readonly clerk;
  constructor(private readonly repository: AccountDeletionRepository, clerkSecret?: string, private readonly apple?: AppleGrantRevoker) {
    this.clerk = clerkSecret ? createClerkClient({ secretKey: clerkSecret }) : undefined;
  }
  closedIdentity(provider: string, subject: string) { return this.repository.closedIdentity(provider, subject); }
  status(id: string, token: string) { return this.repository.status(id, token); }
  async prepare(userId: string) {
    const challenge = await this.repository.prepare(userId);
    const identity = await this.repository.identity(userId);
    if (identity?.provider !== 'clerk' || !this.clerk || !this.apple) return challenge;
    try {
      const user = await this.clerk.users.getUser(identity.subject);
      return { ...challenge, appleAuthorizationAvailable: user.externalAccounts.some(a => a.provider === 'oauth_apple' || a.provider === 'apple') };
    } catch { return challenge; } // Missing Apple credentials must not prevent deletion (Apple TN3194).
  }
  async confirm(userId: string, input: unknown) {
    const confirmation = parseConfirmation(input);
    if (!await this.repository.validateConfirmation(userId, confirmation)) return this.repository.confirm(userId, confirmation);
    const identity = await this.repository.identity(userId);
    let manual = false;
    if (identity?.provider === 'clerk' && this.clerk) {
      try {
        const user = await this.clerk.users.getUser(identity.subject);
        const accounts = user.externalAccounts.filter(a => a.provider === 'apple' || a.provider === 'oauth_apple');
        manual = accounts.length > 0;
        if (accounts.length && this.apple) {
          if (confirmation.appleAuthorizationCode) {
            await this.apple.revokeCode(confirmation.appleAuthorizationCode, accounts[0]!.providerUserId);
            manual = accounts.length > 1;
          } else {
            const tokens = await this.clerk.users.getUserOauthAccessToken(identity.subject, 'apple');
            const usable = tokens.data.filter(t => accounts.some(a => a.id === t.externalAccountId) && (!t.expiresAt || t.expiresAt * 1000 > Date.now()));
            for (const token of usable) await this.apple.revokeToken(token.token);
            manual = !accounts.every(a => usable.some(t => t.externalAccountId === a.id));
          }
        }
      } catch (error) {
        if (error instanceof ServiceError && error.code === 'apple_account_mismatch') throw error;
        // No grant or a provider outage must not leave the person's Impo account undeleted.
        manual = true;
      }
    }
    return this.repository.confirm(userId, confirmation, manual);
  }
}
