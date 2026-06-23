/**
 * User and Account type definitions
 */

export interface User {
  id: string;
  email: string;
  created_at?: string;
  updated_at?: string;
  email_confirmed_at?: string;
  last_sign_in_at?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: UserMetadata;
}

export interface UserMetadata {
  name?: string;
  lastname?: string;
  company?: string;
}

type AccountType = 'individual' | 'team';
export type AccountStatus = 'active' | 'expired' | 'pending' | 'revoked';
export interface Account {
  id: string;
  email: string;
  name: string | null;
  lastname: string | null;
  company_id: string | null;
  subscription_monthly_minutes: number | null;
  subscription_plan_id: string | null;
  subscription_status: SubscriptionStatus | null;
  created_at?: string;
  updated_at?: string;
  is_admin?: boolean;
  isAdmin?: boolean;
  role?: UserRole;
  slack_connected?: boolean;
  zoom_connected?: boolean;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  minutes_balance?: number | null;
  subscription_current_period_end?: string | null;
  subscription_created_at?: string | null;
  last_invoice_paid_at?: string | null;
  subscription_cancelled_at?: string | null;
  subscription_updated_at?: string | null;
  stripe_price_id?: string | null;
  subscription_current_period_start?: string | null;
  account_type: AccountType;
  status: AccountStatus;
  onboarding_status?: 'complete' | 'dismissed' | null;
  desktop_app_latest_version?: string | null;
  desktop_app_os?: string | null;
  desktop_app_updated_at?: string | null;
}
export interface OrgMemberInvite {
    email: string;
    expires_at: string;
    id: string;
    invited_by: string;
    lastname: string;
    name: string;
    status: AccountStatus;
}
export interface OrganizationMembersResponse {
    members: Account[]; 
    invites: OrgMemberInvite[];
}
export interface AccountUsage {
  planMinutes: number;
  remainingMinutes: number;
  rolloverMinutes: number;
  usedMinutes: number;
}

export interface WeeklyActivity {
  totalMinutes: number;
  hasNextWeek: boolean;
  hasPreviousWeek: boolean;
  dailyActivity: DailyActivity[];
}

export interface DailyActivity {
  date: {
    date: string;
    dayShort: string;
  };
  activity: {
    minutes: number;
  } | null;
}

export type SubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'past_due'
  | 'trialing'
  | 'unpaid'
  | 'paused';

export type UserRole = 'admin' | 'user' | 'superadmin';

export interface Company {
  id: string;
  name: string;
  company_name?: string;
  team?: {
    members: any[]; // $FixTS:
  };
}

export interface CreateAccountData {
  email: string;
  name?: string;
  lastname?: string;
  company?: string;
}

export interface UpdateAccountData {
  id?: string;
  name?: string;
  lastname?: string;
  company_id?: string;
  subscription_plan_id?: string;
  subscription_status?: SubscriptionStatus;
  subscription_monthly_minutes?: number;
  onboarding_status?: 'complete' | 'dismissed';
}

export interface AuthContextValue {
  signIn: (data: SignInData) => Promise<AuthResult>;
  handleSignOut: () => Promise<void>;
  user: User | null;
  globalUser: Account | null;
  authToken: string | null;
  userLoading: boolean;
  loading: boolean;
  updateGlobalUser: (accountEmail: string) => Promise<void>;
}

export interface SignInData {
  email: string;
  password: string;
}

export interface AuthResult {
  data: {
    user: User | null;
    session: Session | null;
  };
  error: AuthError | null;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  user: User;
}

export interface AuthError {
  message: string;
  status?: number;
  code?: string;
}