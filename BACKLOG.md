# Bite Point backlog

Player-reported issues worth preserving until they are fixed. These are scoped
as outcomes rather than implementation instructions so the eventual solution
can follow what the simulation and track data actually support.

## Physics

### A stationary car can continue rotating in place

**Observed:** At or near zero road speed, the car can spin about its centre even
when it should have settled and remained stationary.

**Expected:** Residual yaw and low-speed tyre calculations should settle with
the car instead of creating an on-the-spot pirouette. Real wheelspin, donuts,
and power oversteer once the car is actually moving must still work.

**Verify:** Add a low-speed regression covering linear velocity, yaw rate, and
heading over time, including the state after a slide or collision comes to rest.

## Time attack

### The first timed lap needs a fair run-up to the start line

**Observed:** On some circuits, most clearly Elvington Mile, the spawn is too
close to the start/finish line. The first crossing starts a timed lap before the
car has enough speed, making that entire lap uncompetitive; the driver must
complete a full lap before a proper attempt can begin.

**Expected:** The first timed lap should have a representative approach to the
line, just like every later lap. Prefer enough track-specific pre-line run-up;
an explicit rolling-start or out-lap state is another option if placement alone
cannot provide it safely.

**Verify:** Check every released circuit, with Elvington Mile as the regression
case. The first timed crossing must remain forward and valid, while giving the
driver enough distance to reach the normal start-line speed for that circuit.
