"""No-op job."""

from lunarhunt_worker.jobs import run_noop


def test_run_noop() -> None:
    assert run_noop() is None
