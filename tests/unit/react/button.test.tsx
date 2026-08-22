// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '@/components/ui/button'

describe('React DOM test harness', () => {
  it('renders and interacts with an app UI component', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Run check</Button>)

    const button = screen.getByRole('button', { name: 'Run check' })
    expect(button).toBeVisible()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })
})
