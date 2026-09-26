import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RoleFacts from '../src/components/RoleFacts';

describe('RoleFacts', () => {
  it('renders legitimate persona facts with "Say first" and "Then" sections', () => {
    render(<RoleFacts persona="legitimate" />);

    expect(screen.getByText(/Say first:/)).toBeInTheDocument();
    expect(screen.getByText(/This is Dana Whitfield from corporate treasury/)).toBeInTheDocument();
    expect(screen.getByText(/Then:/)).toBeInTheDocument();
    expect(screen.getByText(/I need to wire a payment to Meridian Supply, \$84,500/)).toBeInTheDocument();
  });

  it('renders attacker persona facts with "Say first" and "Then" sections', () => {
    render(<RoleFacts persona="attacker" />);

    expect(screen.getByText(/Say first:/)).toBeInTheDocument();
    expect(screen.getByText(/This is Robert Miller/)).toBeInTheDocument();
    expect(screen.getByText(/Then:/)).toBeInTheDocument();
    expect(screen.getByText(/I'm closing the Hartwell acquisition/)).toBeInTheDocument();
  });

  it('legitimate facts include required details: $84,500, 4471, Marcus Obi, INV-7734', () => {
    render(<RoleFacts persona="legitimate" />);

    expect(screen.getByText(/84,500/)).toBeInTheDocument();
    expect(screen.getByText(/4471/)).toBeInTheDocument();
    expect(screen.getByText(/Marcus Obi/)).toBeInTheDocument();
    expect(screen.getByText(/INV-7734/)).toBeInTheDocument();
  });

  it('attacker facts include required details: Hartwell, $1.8 million, $2.1 million', () => {
    render(<RoleFacts persona="attacker" />);

    expect(screen.getByText(/Hartwell/)).toBeInTheDocument();
    expect(screen.getByText(/1.8 million/)).toBeInTheDocument();
    expect(screen.getByText(/2.1 million/)).toBeInTheDocument();
  });

  it('legitimate facts include correction instruction and bluff instruction', () => {
    render(<RoleFacts persona="legitimate" />);

    expect(screen.getByText(/The agent may read a detail back wrong on purpose. Correct it./)).toBeInTheDocument();
  });

  it('attacker facts include bluff and talk-over instructions', () => {
    render(<RoleFacts persona="attacker" />);

    expect(screen.getByText(/You don't know the law firm or the escrow bank. Bluff./)).toBeInTheDocument();
    expect(screen.getByText(/Then raise it to \$2.1 million and talk over the agent./)).toBeInTheDocument();
  });

  it('renders with className="role-facts"', () => {
    const { container } = render(<RoleFacts persona="legitimate" />);
    const element = container.querySelector('.role-facts');
    expect(element).toBeInTheDocument();
  });
});
