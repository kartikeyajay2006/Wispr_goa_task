from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db.session import get_session
from backend.services.approval_gate import ApprovalGate

router = APIRouter(prefix="/requests", tags=["approval"])


class ApprovalCommand(BaseModel):
    approver_id: str = Field(min_length=1, max_length=255)
    plan_hash: str = Field(min_length=1, max_length=128)
    blast_radius_hash: str = Field(min_length=1, max_length=128)


class RejectCommand(BaseModel):
    approver_id: str = Field(min_length=1, max_length=255)


@router.get("/{request_id}/approval")
async def get_approval(request_id: UUID, session: AsyncSession = Depends(get_session)):
    try:
        return await ApprovalGate(session).current_review(request_id)
    except LookupError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error


@router.post("/{request_id}/approve")
async def approve(request_id: UUID, command: ApprovalCommand, session: AsyncSession = Depends(get_session)):
    try:
        result = await ApprovalGate(session).approve(request_id, command.approver_id, command.plan_hash, command.blast_radius_hash)
        await session.commit()
        return result
    except LookupError as error:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except ValueError as error:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error


@router.post("/{request_id}/reject")
async def reject(request_id: UUID, command: RejectCommand, session: AsyncSession = Depends(get_session)):
    try:
        result = await ApprovalGate(session).reject(request_id, command.approver_id)
        await session.commit()
        return result
    except LookupError as error:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
