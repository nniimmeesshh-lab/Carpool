# Carpool

A simple app for parents to coordinate school drop-offs and pickups.

## Features
- Parent accounts, add your children
- **Pools**: a group (class, team, street) joined with an invite code
- Post drop-off/pickup rides, optionally repeating weekly
- Volunteer to drive, or book your child onto a ride (seat limits enforced)
- Rides without a driver are highlighted; a fairness count shows drives per parent

## Run
Requires Node 22.5+ (uses built-in `node:sqlite`; no npm install needed).

    npm start        # http://localhost:3000  (PORT, DB_PATH env vars)
    npm test
