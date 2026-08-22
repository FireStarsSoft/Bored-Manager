import { describe, expect, it } from 'vitest'
import { specProblems } from '@shared/module-ui'
import { MODULE_API_VERSION, manifestProblems, type ModuleManifest } from '@shared/modules'

const manifest: ModuleManifest = {
  apiVersion: MODULE_API_VERSION,
  id: 'test-module',
  name: 'Test module',
  version: '1.0.0',
  description: 'Fixture',
  author: 'Tests',
  entries: { main: 'main/index.ts' },
  methods: [],
  streams: []
}

describe('module runtime validators', () => {
  it('reports non-array manifest collections instead of throwing', () => {
    const raw = {
      ...manifest,
      pages: 1,
      widgets: {},
      streams: 'bad'
    }
    expect(() => manifestProblems(raw)).not.toThrow()
    expect(manifestProblems(raw)).toEqual(
      expect.arrayContaining([
        'pages is not an array',
        'widgets is not an array',
        'streams is not an array'
      ])
    )
  })

  it('reports malformed nested UI entries instead of throwing', () => {
    const problems = specProblems(
      {
        blocks: [
          {
            type: 'pie',
            source: { kind: 'core', stream: 'system' },
            slices: [null]
          }
        ]
      },
      manifest
    )
    expect(problems).toContain('blocks[0].slices[0] is not an object')
  })

  it('handles cyclic in-memory values used by callers outside JSON parsing', () => {
    const spec: { blocks: unknown[]; self?: unknown } = { blocks: [] }
    spec.self = spec
    expect(() => specProblems(spec, manifest)).not.toThrow()
    expect(specProblems(spec, manifest)).toEqual([])
  })

  it('turns malformed-but-valid manifest JSON into blocking problems', () => {
    const raw = JSON.parse(`{
      "apiVersion": 2,
      "id": "valid-id",
      "name": "Name",
      "version": "1.0.0",
      "description": "Description",
      "author": "Author",
      "entries": {"main": ["not", "a", "path"]},
      "pages": [null, {"id": "main", "label": 1, "icon": {}, "order": "first"}],
      "widgets": [false, {"id": "summary", "label": "Summary", "defaultEnabled": "yes"}],
      "streams": [null, {"event": "tick", "kind": "latest"}, {"event": "tick", "kind": "bad"}],
      "methods": ["run", "run", null],
      "fastInterval": {},
      "slowInterval": []
    }`)
    expect(() => manifestProblems(raw)).not.toThrow()
    expect(manifestProblems(raw)).toEqual(
      expect.arrayContaining([
        'entries.main is not a path',
        'pages contains something that is not an object',
        'widgets contains something that is not an object',
        'streams contains something that is not an object',
        'stream event "tick" is declared twice',
        'methods is not an array of strings',
        'method "run" is declared twice',
        'fastInterval is not a non-empty string',
        'slowInterval is not a non-empty string'
      ])
    )
  })

  it('exhaustively rejects malformed required UI collections without throwing', () => {
    const raw = JSON.parse(`{
      "blocks": [
        {"type": "section", "blocks": {}},
        {"type": "keyValue", "source": null, "rows": [null, {"key": 1}]},
        {"type": "list", "source": {"kind": "core", "stream": "bad"}, "columns": {}},
        {"type": "table", "source": {"kind": "invoke", "method": "missing"}, "columns": [null], "rowActions": {}, "rowDetail": "bad"},
        {"type": "actions", "actions": [null]},
        {"type": "form", "fields": [null], "submit": null},
        {"type": "conditional", "when": [], "blocks": null, "else": {}}
      ],
      "window": "forever"
    }`)
    expect(() => specProblems(raw, manifest)).not.toThrow()
    expect(specProblems(raw, manifest)).toEqual(
      expect.arrayContaining([
        'spec.window is not a valid number',
        'blocks[0].blocks is not an array',
        'blocks[1].rows[0] is not an object',
        'blocks[2].columns is not a non-empty array',
        'blocks[3].columns[0] is not an object',
        'blocks[3].rowActions is not an array',
        'blocks[3].rowDetail is not an array',
        'blocks[4].actions[0] is not an object',
        'blocks[5].fields[0] is not an object',
        'blocks[5].submit is not an object',
        'blocks[6].when is not an object',
        'blocks[6].blocks is not an array',
        'blocks[6].else is not an array'
      ])
    )
  })

  it('bounds deeply nested valid JSON instead of overflowing the stack', () => {
    let block: unknown = { type: 'stat', label: 'end', source: { kind: 'core', stream: 'system' } }
    for (let depth = 0; depth < 100; depth++) block = { type: 'section', blocks: [block] }
    const parsed = JSON.parse(JSON.stringify({ blocks: [block] }))
    expect(() => specProblems(parsed, manifest)).not.toThrow()
    expect(specProblems(parsed, manifest).some((problem) => problem.includes('nesting depth'))).toBe(
      true
    )
  })

  it('accepts subnav, file input and static note specs', () => {
    const problems = specProblems(
      {
        blocks: [
          {
            type: 'subnav',
            initial: 'files',
            items: [
              {
                id: 'files',
                label: 'Files',
                icon: 'FileText',
                blocks: [
                  {
                    type: 'note',
                    title: 'Input format',
                    tone: 'info',
                    lines: ['Use one record per line.']
                  },
                  {
                    type: 'form',
                    fields: [
                      {
                        key: 'contents',
                        label: 'Text file',
                        input: 'file',
                        accept: '.txt,text/plain',
                        maxKb: 1024
                      }
                    ],
                    submit: { label: 'Read', method: 'read' }
                  }
                ]
              },
              { id: 'jobs', label: 'Jobs', icon: 'ListTree', blocks: [] }
            ]
          }
        ]
      },
      { ...manifest, methods: ['read'] }
    )

    expect(problems).toEqual([])
  })

  it('validates subnav items and recursively checks their blocks', () => {
    const problems = specProblems(
      {
        blocks: [
          {
            type: 'subnav',
            initial: 'missing',
            items: [
              {
                id: 'main',
                label: 'Main',
                icon: 'UnknownIcon',
                blocks: [{ type: 'note', lines: [] }]
              },
              { id: 'main', label: 'Duplicate', blocks: [] },
              { id: 'Bad', label: '', blocks: [] }
            ]
          }
        ]
      },
      manifest
    )

    expect(problems).toEqual(
      expect.arrayContaining([
        'blocks[0].items[0].icon "UnknownIcon" is not a module icon',
        'blocks[0].items[1].id "main" is used twice',
        'blocks[0].items[2].id is not a valid subnav id',
        'blocks[0].items[2].label is missing',
        'blocks[0].initial must name a subnav item',
        'blocks[0].items[0].blocks[0].lines must be an array of 1 to 32 non-empty strings'
      ])
    )
    expect(specProblems({ blocks: [{ type: 'subnav', items: [] }] }, manifest)).toContain(
      'blocks[0].items must be an array of 1 to 32 items'
    )
    expect(
      specProblems(
        {
          blocks: [
            {
              type: 'subnav',
              items: Array.from({ length: 33 }, (_, index) => ({
                id: `item-${index}`,
                label: `Item ${index}`,
                blocks: []
              }))
            }
          ]
        },
        manifest
      )
    ).toContain('blocks[0].items must be an array of 1 to 32 items')
  })

  it('restricts file-only field options and validates note bounds', () => {
    const fieldProblems = specProblems(
      {
        blocks: [
          {
            type: 'form',
            fields: [
              { key: 'name', label: 'Name', input: 'text', accept: '.txt', maxKb: 1 },
              { key: 'file', label: 'File', input: 'file', accept: 42, maxKb: 0 }
            ],
            submit: { label: 'Save', method: 'save' }
          }
        ]
      },
      { ...manifest, methods: ['save'] }
    )
    expect(fieldProblems).toEqual(
      expect.arrayContaining([
        'blocks[0].fields[0].accept only applies to a file input',
        'blocks[0].fields[0].maxKb only applies to a file input',
        'blocks[0].fields[1].accept is not a string',
        'blocks[0].fields[1].maxKb is not a valid number'
      ])
    )

    const noteProblems = specProblems(
      {
        blocks: [
          { type: 'note', lines: ['   '], tone: 'danger' },
          { type: 'note', lines: Array.from({ length: 33 }, () => 'line') }
        ]
      },
      manifest
    )
    expect(noteProblems).toEqual(
      expect.arrayContaining([
        'blocks[0].lines must be an array of 1 to 32 non-empty strings',
        'blocks[0].tone must be info or warning',
        'blocks[1].lines must be an array of 1 to 32 non-empty strings'
      ])
    )
  })
})
