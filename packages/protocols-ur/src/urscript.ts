/**
 * URScript builders (spec v1).
 *
 * Pure string builders for the subset of URScript used by this adapter.
 *
 * UNITS — stated explicitly, no guessing:
 * - Positions `x, y, z`: METERS in the robot base frame.
 * - Rotations `rx, ry, rz`: RADIANS, axis-angle representation (UR "rotation
 *   vector", not Euler angles).
 * - `speed`: m/s for linear motion (`movel`), rad/s for joint motion (`movej`).
 * - `acceleration`: m/s² for `movel`/`stopl`, rad/s² for `movej`/`stopj`.
 * - `blendRadius`: METERS. `0` requests an exact stop at the waypoint.
 *
 * These builders do not send anything. Sending raw URScript to a client
 * interface executes it IMMEDIATELY on the controller — see the package
 * README. Nothing here is a safety mechanism.
 */
import { UrScriptError } from './errors.js';

/** UR pose in base-frame meters + axis-angle radians. */
export interface UrPose {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

export interface UrMoveOptions {
  /** Tool speed: m/s (`movel`) or rad/s (`movej`). Default 0.1. */
  speed?: number;
  /** Tool acceleration: m/s² (`movel`) or rad/s² (`movej`). Default 1.2. */
  acceleration?: number;
  /** Blend radius in meters; `0` means exact stop. Default 0. */
  blendRadius?: number;
}

export const UR_DEFAULT_MOVE_SPEED = 0.1;
export const UR_DEFAULT_MOVE_ACCELERATION = 1.2;
/** Conservative default deceleration for `stopl` (m/s²). */
export const UR_DEFAULT_STOP_ACCELERATION = 5;
/** Conservative default joint deceleration for `stopj` (rad/s²). */
export const UR_DEFAULT_STOP_JOINT_ACCELERATION = 5;

/**
 * `movel(pose, a, v, r)` — linear tool move in base-frame meters and
 * axis-angle radians. PHYSICAL MOTION when sent to a controller.
 */
export function buildMoveLCommand(pose: UrPose, options: UrMoveOptions = {}): string {
  assertPose(pose);
  const acceleration = assertPositive(
    'acceleration',
    options.acceleration ?? UR_DEFAULT_MOVE_ACCELERATION,
  );
  const speed = assertPositive('speed', options.speed ?? UR_DEFAULT_MOVE_SPEED);
  const blend = assertNonNegative('blendRadius', options.blendRadius ?? 0);
  return `movel(${formatPose(pose)}, a=${num(acceleration)}, v=${num(speed)}, r=${num(blend)})`;
}

/**
 * `movej(pose, a, v, r)` — joint-space move towards the given pose
 * (base-frame meters + axis-angle radians). `speed` is rad/s, `acceleration`
 * rad/s². PHYSICAL MOTION when sent to a controller.
 */
export function buildMoveJCommand(pose: UrPose, options: UrMoveOptions = {}): string {
  assertPose(pose);
  const acceleration = assertPositive(
    'acceleration',
    options.acceleration ?? UR_DEFAULT_MOVE_ACCELERATION,
  );
  const speed = assertPositive('speed', options.speed ?? UR_DEFAULT_MOVE_SPEED);
  const blend = assertNonNegative('blendRadius', options.blendRadius ?? 0);
  return `movej(${formatPose(pose)}, a=${num(acceleration)}, v=${num(speed)}, r=${num(blend)})`;
}

/** `stopl(a)` — decelerate linear tool motion. `a` in m/s². */
export function buildStopLCommand(acceleration: number = UR_DEFAULT_STOP_ACCELERATION): string {
  return `stopl(${num(assertPositive('acceleration', acceleration))})`;
}

/** `stopj(a)` — decelerate joint motion. `a` in rad/s². */
export function buildStopJCommand(
  acceleration: number = UR_DEFAULT_STOP_JOINT_ACCELERATION,
): string {
  return `stopj(${num(assertPositive('acceleration', acceleration))})`;
}

/** `sleep(seconds)`. Not a substitute for waiting for motion completion. */
export function buildSleepCommand(seconds: number): string {
  return `sleep(${num(assertNonNegative('seconds', seconds))})`;
}

/** Join script lines into a newline-terminated URScript snippet. */
export function buildScript(lines: readonly string[]): string {
  const trimmed = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  return `${trimmed.join('\n')}\n`;
}

export function formatPose(pose: UrPose): string {
  return `p[${num(pose.x)}, ${num(pose.y)}, ${num(pose.z)}, ${num(pose.rx)}, ${num(pose.ry)}, ${num(pose.rz)}]`;
}

function assertPose(pose: UrPose): void {
  for (const key of ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const) {
    const value = pose[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new UrScriptError(
        'UR_SCRIPT_INVALID_POSE',
        `Pose component '${key}' must be a finite number (meters for x/y/z, radians for rx/ry/rz); received ${String(value)}.`,
      );
    }
  }
}

function assertPositive(field: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new UrScriptError(
      'UR_SCRIPT_INVALID_ARGUMENT',
      `'${field}' must be a positive finite number; received ${String(value)}.`,
    );
  }
  return value;
}

function assertNonNegative(field: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new UrScriptError(
      'UR_SCRIPT_INVALID_ARGUMENT',
      `'${field}' must be a non-negative finite number; received ${String(value)}.`,
    );
  }
  return value;
}

function num(value: number): string {
  return `${value}`;
}
