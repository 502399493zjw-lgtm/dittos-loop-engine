import { describe, it, expect } from 'vitest'
import { fakeGithubOAuth } from '../src/auth/github'

describe('fakeGithubOAuth', () => {
  it('authorizeUrl contains client_id, state and read:user scope', () => {
    const gh = fakeGithubOAuth({ user: { id: 1, login: 'octocat' } })
    const url = gh.authorizeUrl('the-state')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('client_id')).toBeTruthy()
    expect(parsed.searchParams.get('state')).toBe('the-state')
    expect(parsed.searchParams.get('scope')).toBe('read:user')
  })

  it('exchangeCode returns the scripted access token and records the call', async () => {
    const gh = fakeGithubOAuth({ user: { id: 1, login: 'octocat' }, accessToken: 'tok-123' })
    const token = await gh.exchangeCode('the-code')
    expect(token).toBe('tok-123')
    expect(gh.calls.exchangeCode).toEqual(['the-code'])
  })

  it('exchangeCode defaults to a synthetic token when none configured', async () => {
    const gh = fakeGithubOAuth({ user: { id: 1, login: 'octocat' } })
    expect(await gh.exchangeCode('c')).toBeTruthy()
  })

  it('fetchUser returns the scripted user and records the call', async () => {
    const user = { id: 42, login: 'octocat', name: 'The Octocat' }
    const gh = fakeGithubOAuth({ user, accessToken: 'tok-123' })
    const got = await gh.fetchUser('tok-123')
    expect(got).toEqual(user)
    expect(gh.calls.fetchUser).toEqual(['tok-123'])
  })
})
