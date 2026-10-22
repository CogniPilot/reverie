import { describe, expect, it } from 'vitest';
import { boardOwnerIds } from '../src/board-logic.js';

describe('board display owner identity', () => {
  it('matches names case-insensitively while explicit employee ids win over labels', () => {
    const roster = [{id:'person-one',name:'Morgan'},{id:'person-two',name:'Taylor'}];
    const issues = [{id:'label',ownerLabel:'  MORGAN '},{id:'literal',owner:'morgan'},{id:'explicit',owner:'person-two',ownerLabel:'Morgan'}];
    const before = JSON.stringify(issues);
    expect(boardOwnerIds(issues,roster)).toEqual({label:'person-one',literal:'person-one',explicit:'person-two'});
    expect(JSON.stringify(issues)).toBe(before);
  });

  it('does not guess for duplicate names, unknown ids, or special label-only rows', () => {
    const roster = [{id:'person-one',name:'Morgan'},{id:'person-two',name:'MORGAN'}];
    expect(boardOwnerIds([
      {id:'ambiguous',ownerLabel:'morgan'},
      {id:'unknown',owner:'missing-person',ownerLabel:'Morgan'},
      {id:'owner',ownerLabel:'Owner'},
      {id:'sleep',ownerLabel:'Sleep'},
      {id:'explicit',owner:'person-one'},
    ],roster)).toEqual({explicit:'person-one'});
  });

  it('uses ordinary issue ids safely even when they are object property names', () => {
    const ids=boardOwnerIds([{id:'constructor',owner:'Morgan'},{id:'__proto__',ownerLabel:'Morgan'}],[{id:'person-one',name:'Morgan'}]);
    expect(Object.hasOwn(ids,'constructor')).toBe(true);
    expect(Object.hasOwn(ids,'__proto__')).toBe(true);
    expect(ids['__proto__']).toBe('person-one');
    expect(Object.getPrototypeOf(ids)).toBe(Object.prototype);
  });
});
