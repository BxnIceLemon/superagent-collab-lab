import { describe, expect, it } from 'vitest'
import { githubOriginals, nl2repoOriginals, nl2repoProjectName } from '../src/benchmarks.ts'
import { blockedPhrases } from '../src/network.ts'

const SOURCES = [
  { name: 'nl2repo' as const, title: 'NL2Repo-Bench', repository: 'https://github.com/multimodal-art-projection/NL2RepoBench', commit: 'a'.repeat(40), license: null, paper: 'https://example.org/p' },
  { name: 'e2edev' as const, title: 'E2EDev', repository: 'https://github.com/SCUNLP/E2EDev', commit: 'b'.repeat(40), license: null, paper: 'https://example.org/q' },
]

describe('network policy phrases', () => {
  it('names every benchmark repository and the task originals, once each', () => {
    const phrases = blockedPhrases(SOURCES, { name: 'nl2repo', item: 'decouple', commit: 'a'.repeat(40), originals: ['decouple', 'Python-Decouple'] })
    expect(phrases).toEqual([
      'nl2repo', 'NL2Repo-Bench', 'multimodal-art-projection/NL2RepoBench',
      'e2edev', 'SCUNLP/E2EDev',
      'decouple', 'Python-Decouple',
    ])
  })

  it('reads the GitHub repositories and accounts a prompt links', () => {
    const prompt = 'Images from https://github.com/bradtraversy/vanillawebprojects/blob/master/x.jpg and https://github.com/bradtraversy/vanillawebprojects/blob/master/y.mp3. By https://github.com/msranjana.'
    expect(githubOriginals(prompt)).toEqual(['bradtraversy/vanillawebprojects', 'github.com/msranjana'])
  })

  it('reads the project name from an NL2Repo-Bench heading', () => {
    expect(nl2repoProjectName('## Introduction and Goals of the Python-Decouple Project\n')).toBe('Python-Decouple')
    expect(nl2repoProjectName('﻿## Introduction and Goals of the Python-Markdownify Project')).toBe('Python-Markdownify')
    expect(nl2repoProjectName('# Introduction to the Tenacity Project')).toBe('Tenacity')
    expect(nl2repoProjectName('## Parse Project Introduction and Goals')).toBe('Parse')
    expect(nl2repoProjectName('# Bleach HTML Security Cleaning Library - Complete Documentation')).toBeNull()
    expect(nl2repoProjectName('# Sklearn-pandas')).toBe('Sklearn-pandas')
    expect(nl2repoProjectName('## Project Introduction and Goals')).toBeNull()
  })

  it('keeps the names a library is published under, not the generic part of one', () => {
    expect(nl2repoOriginals('decouple', 'Python-Decouple')).toEqual(['decouple', 'Python-Decouple'])
    expect(nl2repoOriginals('jinja', 'Jinja2')).toEqual(['jinja', 'Jinja2'])
    expect(nl2repoOriginals('sklearn', 'Sklearn-pandas')).toEqual(['Sklearn-pandas'])
    expect(nl2repoOriginals('trimming', 'CSV-Trimming')).toEqual(['CSV-Trimming'])
    expect(nl2repoOriginals('pdfplumber-stable', null)).toEqual(['pdfplumber-stable', 'pdfplumber'])
    expect(nl2repoOriginals('arguably', 'Arguably')).toEqual(['arguably'])
  })
})
