/**
 * Transaction preparation: simulate an invocation the client built, and hand back
 * the same call with a footprint and resource fee filled in.
 *
 * THE PROPERTY THAT MATTERS
 * The returned envelope is the client's own operation list, unchanged. The server
 * cannot change which contract is called, which method, or with what arguments —
 * it only adds what the protocol requires to make the call valid. That is what
 * keeps a compromised API from being a way to get a user's signature onto
 * something else. A fee-bump envelope is refused rather than unwrapped, because
 * unwrapping means re-building and re-wrapping a transaction whose inner contents
 * this service would then be handling on the client's behalf; fee sponsorship is
 * not part of this protocol, so there is no reason to accept one.
 *
 * WHY THE SERVER DOES THIS AT ALL
 * The document puts "Simulate" before "Show details" and before the wallet
 * signature, and it lists transaction-preparation APIs as part of this service. A
 * client that would rather simulate against RPC itself can, and the web app does:
 * nothing here is a prerequisite for a write.
 *
 * WHAT IT REFUSES
 * Only invocations of the protocol's own contracts, identified by the Factory's
 * address or by a group the index knows about. Without that, this would be an
 * open simulation proxy — free compute for anyone with a session — and it is the
 * one place where "prepare" could be pointed at something that is not ours.
 */
import {
  Address,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';

/** The largest unsigned invocation that can be legitimate. */
export const MAX_ENVELOPE_LENGTH = 16 * 1024;

/**
 * Why an envelope was refused before any simulation.
 *
 * Machine-readable and deliberately coarse: a client needs to know what kind of
 * refusal it was, not which byte failed to parse, and a detailed reason would tell
 * an attacker probing this endpoint which of their guesses was closest.
 */
export type PrepareRefusal =
  /** Not parseable as a transaction, or signed for a different network. */
  | 'malformed_envelope'
  /** A multi-operation transaction. One intent per request, so one review. */
  | 'not_a_single_invocation'
  /** A single operation, but not a contract invocation (a payment, a deploy). */
  | 'not_an_invocation'
  /** An invocation of something that is not this protocol's Factory or a known group. */
  | 'contract_not_allowed';

/** The invocation found inside an envelope, with the transaction that carries it. */
export type InvocationEnvelope = {
  readonly transaction: Transaction;
  readonly contractId: string;
  readonly method: string;
};

export type PrepareOutcome =
  /**
   * The call simulated successfully. `preparedXdr` is the same operation list with
   * the resource footprint and fee filled in, ready for the wallet to sign.
   */
  | {
      readonly status: 'prepared';
      readonly preparedXdr: string;
      readonly contractId: string;
      readonly method: string;
    }
  /**
   * The contract refused it, which is a normal answer — "you already contributed
   * to this round" is not an error in the transport sense. `rawError` is passed
   * through so the client decodes it with the error table it already has, rather
   * than this service keeping a second copy that could drift from the contracts.
   */
  | {
      readonly status: 'refused';
      readonly contractId: string;
      readonly method: string;
      readonly rawError: string;
    }
  /**
   * The contract's data has expired and must be restored before the call can run.
   * Reported separately because the remedy is specific and the client should not
   * present it as a failure of the user's action.
   */
  | { readonly status: 'restore_required'; readonly contractId: string; readonly method: string }
  /** A simulation response this service does not recognise. Never treated as success. */
  | { readonly status: 'unrecognized'; readonly contractId: string; readonly method: string }
  /**
   * The simulation never answered, or the transport failed before an answer
   * could arrive. Distinct from `refused`: the contract said nothing, so the
   * client must not read this as a verdict on its call. The route maps it to
   * 503, a retryable upstream failure, rather than the generic 500.
   */
  | { readonly status: 'unavailable'; readonly contractId: string; readonly method: string }
  /** Refused before simulation. */
  | { readonly status: 'invalid'; readonly reason: PrepareRefusal };

/**
 * Reads the single contract invocation out of an unsigned envelope.
 *
 * THE NETWORK, AND WHY IT CANNOT BE CHECKED HERE
 * A Stellar transaction envelope does not carry a network id. The network is only
 * ever implied: it is mixed into the hash that signatures are made over. So there
 * is no field to compare, and parsing an envelope while passing this service's
 * passphrase cannot fail because the envelope was built for a different network.
 * Whoever wrote an earlier version of this comment assumed otherwise; the SDK tests
 * say plainly that `fromXDR` accepts any passphrase.
 *
 * What that means in practice: the passphrase passed here decides which network the
 * *prepared* envelope is bound to, since assembly records it. The client, not this
 * service, chooses the network it signs and submits on, so a client on another
 * network gets a transaction that network will reject — it cannot be quietly
 * submitted elsewhere.
 *
 * Signatures are not required and not checked: an unsigned envelope is exactly the
 * input this endpoint expects, and a signed one is not more trustworthy — a
 * signature over a transaction this service did not build tells it nothing.
 */
export function parseInvocationEnvelope(
  envelopeXdr: string,
  networkPassphrase: string,
): InvocationEnvelope | PrepareRefusal {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  } catch {
    return 'malformed_envelope';
  }

  if (parsed instanceof FeeBumpTransaction) return 'malformed_envelope';
  if (!(parsed instanceof Transaction)) return 'malformed_envelope';

  const operations = parsed.operations;
  if (operations.length !== 1) return 'not_a_single_invocation';

  const operation = operations[0];
  if (operation === undefined) return 'not_a_single_invocation';
  if (operation.type !== 'invokeHostFunction') return 'not_an_invocation';

  // This SDK's XDR is a discriminated union on a string `type`, not the older
  // `switch()` API, and a variant's payload is a property, not a method.
  const hostFunction = operation.func;
  if (hostFunction.type !== 'hostFunctionTypeInvokeContract') return 'not_an_invocation';

  const invoke = hostFunction.invokeContract;
  const contractId = Address.fromScAddress(invoke.contractAddress).toString();
  const method = invoke.functionName.toString();

  return { transaction: parsed, contractId, method };
}

export type PrepareOptions = {
  readonly envelopeXdr: string;
  readonly networkPassphrase: string;
  readonly simulate: (transaction: Transaction) => Promise<rpc.Api.SimulateTransactionResponse>;
  /**
   * How long a simulation may take before it is treated as an upstream
   * failure. A hung RPC must not hold the HTTP request — and its rate-limit
   * budget — open indefinitely.
   */
  readonly simulationTimeoutMs: number;
  /**
   * Whether this contract may be simulated here.
   *
   * Injected rather than imported because the answer combines the Factory address
   * with the group index and the short-lived registrations, and this module should
   * not know about databases.
   */
  readonly isAllowedContract: (contractId: string) => Promise<boolean>;
};

/** Rejects if `promise` does not settle within `ms`. The timer is unref'd so a hung promise cannot hold the process open on its own. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`simulation timed out after ${ms}ms`)), ms);
    // `unref` exists in Node and is absent in edge runtimes; guarded so this
    // helper stays portable.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  // The loser keeps running in the background: stellar-sdk's simulateTransaction
  // takes no AbortSignal, so there is nothing to cancel it with. The race only
  // decides which settlement the caller sees. A hung RPC therefore still holds
  // its socket until it settles, but it no longer holds the HTTP request or the
  // rate-limit budget.
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function prepareInvocation(options: PrepareOptions): Promise<PrepareOutcome> {
  const { envelopeXdr, networkPassphrase, simulate, simulationTimeoutMs, isAllowedContract } =
    options;

  const parsed = parseInvocationEnvelope(envelopeXdr, networkPassphrase);
  if (typeof parsed === 'string') return { status: 'invalid', reason: parsed };

  const { transaction, contractId, method } = parsed;

  if (!(await isAllowedContract(contractId))) {
    return { status: 'invalid', reason: 'contract_not_allowed' };
  }

  // Transport failures and timeouts are upstream failures, not contract
  // verdicts. They must not reach the `isSimulationError` branch below, which
  // reports the contract's own refusal — a hung RPC saying nothing is not the
  // contract saying no. Any throw from `simulate` means no simulation response
  // arrived, so `unavailable` is the only honest classification; a logic error
  // inside the simulator is indistinguishable from a transport failure here,
  // and both are transient from the client's perspective.
  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await withTimeout(simulate(transaction), simulationTimeoutMs);
  } catch {
    return { status: 'unavailable', contractId, method };
  }

  if (rpc.Api.isSimulationError(simulation)) {
    return { status: 'refused', contractId, method, rawError: String(simulation.error) };
  }

  if (rpc.Api.isSimulationRestore(simulation)) {
    return { status: 'restore_required', contractId, method };
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    return { status: 'unrecognized', contractId, method };
  }

  const prepared = rpc.assembleTransaction(transaction, simulation).build();
  const preparedXdr = prepared.toXDR();

  // Defence in depth. `assembleTransaction` fills in resources and a fee; it cannot
  // rewrite the operation list. If it ever could — a future SDK, a bug — the
  // property this endpoint rests on would be gone, so the result is re-parsed and
  // checked rather than trusted. A mismatch is reported as unrecognised, never as
  // a prepared transaction.
  const check = parseInvocationEnvelope(preparedXdr, networkPassphrase);
  if (typeof check === 'string' || !keepsInvocation(parsed, check)) {
    return { status: 'unrecognized', contractId, method };
  }

  return { status: 'prepared', preparedXdr, contractId, method };
}

/**
 * Whether a prepared envelope still is the invocation that was submitted.
 *
 * The same contract, the same method, and the same source account: the account
 * that signs has to be the account the client chose. Argument *values* are
 * deliberately not compared here — they are carried unchanged by the SDK's
 * cloning, and re-encoding them to compare would be a second implementation of
 * the very thing being trusted.
 *
 * Exported so the fail-closed property is tested directly, rather than only
 * through the SDK path that is expected never to violate it.
 */
export function keepsInvocation(
  original: InvocationEnvelope,
  prepared: InvocationEnvelope,
): boolean {
  return (
    original.contractId === prepared.contractId &&
    original.method === prepared.method &&
    original.transaction.source === prepared.transaction.source
  );
}
