import type {
  CandidateArgument,
  CandidateArgumentSchema,
  CandidateCapability,
  CandidateSafetyConstraint,
  HardwareInterfaceIR,
  Uncertainty,
} from '../types/ir.js';

const READ_ONLY_HINTS =
  /^(.*\.(read|get|status|info|hello|ping|scan|list)|sensor\.|temperature\.read|humidity\.read|pressure\.read|ble\.gatt\..*\.read|mqtt\.subscribe\.|http\.get\.)/i;

const PHYSICAL_OUTPUT_HINTS =
  /\.(write|set|on|off|move|home|start|stop|arm|disarm|toggle|pulse|pwm|servo|motor|batch|publish|cmd|command)|gpio\.(write|mode|pwm|servo|motor|pulse|toggle|batchWrite|stopAll|configSafeState)|sys\.(arm|disarm)|watchdog\.|ble\.gatt\..*\.(write|notify)|mqtt\.publish\.|http\.(put|post|patch|delete)\./i;

/**
 * Classify capabilities read-only vs physicalOutput, attach strict schemas for
 * physical outputs, and emit DEFAULT-DENY policy stubs (requiresApproval) when
 * human-supplied ranges are missing. Never invents numeric bounds.
 */
export function applyCapabilitySafetyInference(ir: HardwareInterfaceIR): HardwareInterfaceIR {
  const uncertainties = [...ir.uncertainties];
  const safety: CandidateSafetyConstraint[] = [...ir.safety];
  const capabilities = ir.capabilities.map((cap) =>
    classifyAndStrictify(cap, safety, uncertainties),
  );

  return {
    ...ir,
    capabilities,
    safety,
    uncertainties,
  };
}

function classifyAndStrictify(
  cap: CandidateCapability,
  safety: CandidateSafetyConstraint[],
  uncertainties: Uncertainty[],
): CandidateCapability {
  const safetyClass =
    cap.safetyClass ??
    (READ_ONLY_HINTS.test(cap.id)
      ? 'readOnly'
      : PHYSICAL_OUTPUT_HINTS.test(cap.id)
        ? 'physicalOutput'
        : 'unknown');

  const next: CandidateCapability = {
    ...cap,
    safetyClass,
  };

  if (safetyClass === 'readOnly') {
    next.reversible = true;
    next.requiresApproval = false;
    if (!next.outputSchema && next.output) {
      next.outputSchema = toStrictSchema(next.output, false);
    }
    return next;
  }

  if (safetyClass === 'unknown') {
    next.requiresApproval = true;
    uncertainties.push({
      id: `safety-class-unknown-${slug(cap.id)}`,
      message: `Capability '${cap.id}' could not be classified as read-only or physicalOutput; left explicit unknown.`,
      severity: 'warning',
      confidence: 0.6,
      evidence: cap.evidence,
    });
    return next;
  }

  // physicalOutput
  next.requiresApproval = true;
  next.reversible = cap.reversible ?? true;
  next.reversibilityNotes =
    cap.reversibilityNotes ??
    'Physical actuation candidate — confirm reversible safe-state before hardware use.';

  const strictArgs = buildStrictPhysicalArgs(cap);
  next.arguments = strictArgs;
  next.inputSchema = toStrictSchema(strictArgs, true);

  const documentedRanges = safety.filter(
    (s) =>
      s.capability === cap.id &&
      s.type === 'range' &&
      s.documented &&
      !s.requiresHumanReview &&
      s.argument,
  );

  if (documentedRanges.length === 0) {
    // DEFAULT-DENY stub — do not invent min/max.
    for (const [argName, arg] of Object.entries(strictArgs)) {
      if (arg.type === 'number' || arg.type === 'integer') {
        const already = safety.some(
          (s) => s.capability === cap.id && s.argument === argName && s.requiresApproval,
        );
        if (!already) {
          safety.push({
            type: 'candidate',
            capability: cap.id,
            argument: argName,
            message: `NO SAFE RANGE FOUND for ${cap.id}.${argName} — human-supplied bounds required (requiresApproval).`,
            confidence: 0.2,
            evidence: cap.evidence,
            requiresHumanReview: true,
            documented: false,
            requiresApproval: true,
          });
        }
        // Observed sample min/max are hints only — strip from hard schema bounds
        // unless they came from documented safety (they didn't here).
        if (arg.minimum !== undefined || arg.maximum !== undefined) {
          uncertainties.push({
            id: `observed-range-${slug(cap.id)}-${argName}`,
            message: `Observed sample range for ${cap.id}.${argName} is data, not a hard safety limit; policy remains default-deny.`,
            severity: 'info',
            confidence: 0.7,
            evidence: cap.evidence,
          });
          delete arg.minimum;
          delete arg.maximum;
        }
      }
    }
    next.requiresApproval = true;
  } else {
    // Promote documented ranges into strict schema bounds.
    for (const range of documentedRanges) {
      if (!range.argument) {
        continue;
      }
      const arg = strictArgs[range.argument];
      if (!arg) {
        continue;
      }
      if (range.minimum !== undefined) {
        arg.minimum = range.minimum;
      }
      if (range.maximum !== undefined) {
        arg.maximum = range.maximum;
      }
    }
    next.inputSchema = toStrictSchema(strictArgs, true);
    // Documented hard ranges may still need human review before install, but
    // they are eligible for declarative policies (existing emitter rules).
    next.requiresApproval = documentedRanges.some((r) => r.requiresHumanReview) || false;
  }

  return next;
}

function buildStrictPhysicalArgs(cap: CandidateCapability): Record<string, CandidateArgument> {
  if (cap.arguments && Object.keys(cap.arguments).length > 0) {
    const out: Record<string, CandidateArgument> = {};
    for (const [key, arg] of Object.entries(cap.arguments)) {
      out[key] = { ...arg };
      if (arg.enumValues && arg.enumValues.length > 0) {
        out[key]!.enumValues = [...arg.enumValues];
      }
    }
    return out;
  }
  // Minimal non-invented stub: boolean enable or opaque value — still requiresApproval.
  if (/\.(on|off|arm|disarm|toggle|stop|home|start)$/i.test(cap.id)) {
    return {};
  }
  return {
    value: {
      name: 'value',
      type: 'number',
      required: true,
      description: 'Actuation value — bounds require human approval (no documented range).',
    },
  };
}

function toStrictSchema(
  args: Record<string, CandidateArgument>,
  requireListed: boolean,
): CandidateArgumentSchema {
  const required = Object.entries(args)
    .filter(([, arg]) => arg.required || requireListed)
    .map(([key]) => key);
  return {
    type: 'object',
    additionalProperties: false,
    properties: { ...args },
    ...(required.length > 0 ? { required } : {}),
  };
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}
