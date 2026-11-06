import test from 'node:test';
import assert from 'node:assert/strict';
import { redactNarrativeContent } from '../../scripts/narrative-data-requests.mjs';

test('account erasure clears established prose and generated prop labels but retains shared state and replay receipts', () => {
  const state = {
    narrativeCanon: {
      revision: 1,
      turns: [
        {
          id: 'turn',
          narration: 'PRIVATE',
          evidenceIds: [],
          storyProposalHash: 'hash',
          establishedEvents: [
            {
              id: 'rp-turn-0-0',
              description: 'PRIVATE EVENT',
              requestHash: 'receipt',
              actorId: 'alice',
              audienceIds: ['alice'],
              effects: [
                {
                  kind: 'create_prop',
                  ref: 'PRIVATE_REF',
                  name: 'PRIVATE NAME',
                  description: 'PRIVATE DESCRIPTION',
                },
                { kind: 'public_condition', targetId: 'PRIVATE_REF', description: 'PRIVATE CONDITION' },
                { kind: 'door_state', targetId: 'door', open: true, locked: false },
              ],
            },
          ],
        },
      ],
    },
    entities: {
      prop: {
        id: 'rp-turn-0-0-0',
        kind: 'item',
        ownerId: 'bob',
        label: 'PRIVATE NAME',
        publicCondition: 'PRIVATE CONDITION',
        revision: 2,
      },
      door: {
        id: 'door',
        kind: 'door',
        open: true,
        locked: false,
        publicCondition: 'PRIVATE CONDITION',
        revision: 3,
      },
    },
  };
  redactNarrativeContent(state);
  assert.equal(JSON.stringify(state).includes('PRIVATE'), false);
  assert.equal(state.entities.prop.ownerId, 'bob');
  assert.equal(state.narrativeCanon.turns[0].establishedEvents[0].effects[0].ref, 'rp-turn-0-0-0');
  assert.equal(
    state.narrativeCanon.turns[0].establishedEvents[0].effects[1].targetId,
    'rp-turn-0-0-0',
  );
  assert.equal(state.entities.prop.id, 'rp-turn-0-0-0');
  assert.equal(state.entities.door.open, true);
  assert.equal(state.entities.door.revision, 3);
  assert.equal(state.narrativeCanon.turns[0].storyProposalHash, 'hash');
  assert.equal(state.narrativeCanon.turns[0].establishedEvents[0].requestHash, 'receipt');
});
